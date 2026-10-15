// chat-vision.mjs — multimodal (chart-image) support for the advisory chat plane.
//
// Three live-probed facts drive this module (ADR-010):
//
//  1. Workers AI accepts an image ONLY as an OpenAI content part
//     ({type:"image_url", image_url:{url:"data:image/png;base64,...", detail}})
//     on the `user` role — the top-level `image` parameter is deprecated, and
//     system/assistant turns cannot carry one.
//  2. Appending "/no_think" to ARRAY content string-coerces it to
//     "[object Object]", and the model then answers about that literal string
//     ("It seems like you've posted \"[object Object]\""). The directive must
//     land on the text PART, never on the array.
//  3. Qwen3 needs BOTH reasoning_effort:"low" AND
//     chat_template_kwargs:{enable_thinking:false} to actually stop emitting a
//     chain-of-thought; either one alone still fills `reasoning` and leaves
//     `content` null.
//
// Storage: bytes never touch D1 — its 2 MB per-row/string cap cannot hold a
// base64 blob. The R2 bucket (env.CHAT_MEDIA) is the durable store and D1 keeps
// only the metadata row, so "which chart produced this code?" stays answerable.
import { uid } from "./_shared.mjs";

// IMAGE_TYPES is the media-type allow-list (what the dashboard can downscale to).
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// MAX_IMAGE_BYTES bounds the DECODED image. The client downscales to a 1568px
// longest edge before upload (~1400 prompt tokens at detail:"low"); anything
// larger is rejected rather than silently billed.
export const MAX_IMAGE_BYTES = 1_500_000;
// VISION_MODEL_DEFAULT is overridden per-env by AI_VISION_MODEL.
export const VISION_MODEL_DEFAULT = "@cf/qwen/qwen3.8-27b";

/** hasImage reports whether any turn carries an image content part. */
export function hasImage(messages) {
  return (messages ?? []).some(
    (m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === "image_url"),
  );
}

/** appendNoThink appends the directive to a turn's TEXT, whatever shape
 *  `content` has. Array (multimodal) content must never be string-coerced. */
export function appendNoThink(msg) {
  if (!msg || typeof msg !== "object") return msg;
  if (typeof msg.content === "string") {
    msg.content += "\n/no_think";
    return msg;
  }
  if (Array.isArray(msg.content)) {
    // The directive belongs on the TEXT part wherever it sits in the array —
    // the image part is often last, so "the last element" is the wrong target.
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const p = msg.content[i];
      if (p && p.type === "text") {
        p.text = `${p.text ?? ""}\n/no_think`;
        return msg;
      }
    }
    msg.content.push({ type: "text", text: "/no_think" });
    return msg;
  }
  msg.content = "/no_think";
  return msg;
}

/** reasoningOpts returns the run() options that switch a Qwen3 model out of
 *  thinking mode. Live tail (2026-10-14) proved reasoning_effort +
 *  chat_template_kwargs do NOT stop the thinking trace on
 *  @cf/qwen/qwen3-30b-a3b-fp8 — the answer lands in `reasoning` and `content`
 *  comes back null. The only switch that works is enable_thinking:false at the
 *  top level of the run() options (Workers AI maps it to the chat template). */
export function reasoningOpts(model) {
  if (!/qwen/i.test(String(model ?? ""))) return {};
  return { enable_thinking: false };
}

/** decodeDataURL parses "data:<type>;base64,<payload>" into decoded bytes.
 *  Returns null for anything that is not a base64 data URL. */
export function decodeDataURL(dataUrl) {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ""));
  if (!m) return null;
  const mediaType = m[1].toLowerCase();
  const payload = m[2].replace(/\s+/g, "");
  let bin;
  try {
    bin = atob(payload);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mediaType, bytes };
}

/** sha256Hex is the provenance digest stored alongside the R2 key. */
export async function sha256Hex(bytes) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null; // digest is provenance, not a gate — never block the answer
  }
}

/** imageParts flattens the image parts of one turn into {mediaType, bytes} rows,
 *  dropping anything that fails the allow-list / size cap. */
export function imageParts(msg) {
  if (msg?.role !== "user" || !Array.isArray(msg.content)) return [];
  const out = [];
  for (const part of msg.content) {
    if (part?.type !== "image_url") continue;
    const decoded = decodeDataURL(part.image_url?.url);
    if (!decoded) continue;
    if (!IMAGE_TYPES.has(decoded.mediaType)) continue;
    if (decoded.bytes.length > MAX_IMAGE_BYTES) continue;
    out.push({ ...decoded, detail: part.image_url?.detail ?? "low" });
  }
  return out;
}

/** persistAttachments stores every image of the current turn in R2 and records
 *  its metadata in D1, returning the saved refs. Deliberately fail-soft at the
 *  call site: chat is advisory, so a storage outage must not silence the model. */
export async function persistAttachments(env, { sessionId, messages, nowMs } = {}) {
  const saved = [];
  const at = new Date(nowMs ?? Date.now()).toISOString();
  for (const m of messages ?? []) {
    for (const img of imageParts(m)) {
      const messageId = String(m.id ?? "").trim() || uid("msg");
      const key = `chat/${sessionId || "anon"}/${messageId}/${uid("img")}`;
      const sha256 = await sha256Hex(img.bytes);
      if (env.CHAT_MEDIA) {
        await env.CHAT_MEDIA.put(key, img.bytes, {
          httpMetadata: { contentType: img.mediaType },
        });
      }
      if (env.DB) {
        await env.DB.prepare(
          "INSERT INTO chat_attachments(id,message_id,session_id,role,media_type,bytes,r2_key,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ).bind(uid("att"), messageId, sessionId ?? "", m.role, img.mediaType, img.bytes.length, key, sha256, at).run();
      }
      saved.push({ messageId, r2Key: key, mediaType: img.mediaType, bytes: img.bytes.length, sha256 });
    }
  }
  return saved;
}
