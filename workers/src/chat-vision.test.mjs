// chat-vision.test.mjs — multimodal chat helpers (ADR-010).
//
// Acceptance frame: (1) /no_think lands on the TEXT part and array content is
// never string-coerced to "[object Object]"; (2) Qwen3 gets BOTH reasoning
// switches, other models get none; (3) chart bytes go to R2 and the metadata
// row to D1 (never a blob in D1); (4) the media-type allow-list and the decoded
// size cap fail closed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasImage, appendNoThink, reasoningOpts, decodeDataURL, sha256Hex, imageParts,
  persistAttachments, IMAGE_TYPES, MAX_IMAGE_BYTES, VISION_MODEL_DEFAULT,
} from "./chat-vision.mjs";

// 1x1 PNG (67 bytes decoded) — a real, decodable image.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

const textPart = (t) => ({ type: "text", text: t });
const imgPart = (url = DATA_URL) => ({ type: "image_url", image_url: { url, detail: "low" } });

describe("chat-vision — /no_think never stringifies array content", () => {
  it("appends to a plain string turn", () => {
    const m = { role: "user", content: "hi" };
    appendNoThink(m);
    assert.equal(m.content, "hi\n/no_think");
  });

  it("appends to the TEXT part of a multimodal turn (no [object Object])", () => {
    const m = { role: "user", content: [textPart("what is this?"), imgPart()] };
    appendNoThink(m);
    assert.ok(Array.isArray(m.content));
    assert.equal(m.content[0].text, "what is this?\n/no_think");
    assert.equal(m.content[1].type, "image_url");
    assert.ok(!JSON.stringify(m.content).includes("[object Object]"));
  });

  it("pushes a text part when the array has no text part", () => {
    const m = { role: "user", content: [imgPart()] };
    appendNoThink(m);
    assert.equal(m.content.length, 2);
    assert.deepEqual(m.content.at(-1), { type: "text", text: "/no_think" });
  });

  it("is a no-op-safe on a missing turn", () => {
    assert.equal(appendNoThink(null), null);
  });
});

describe("chat-vision — reasoning switches (probed live)", () => {
  it("sends BOTH switches for a Qwen3 model", () => {
    const o = reasoningOpts("@cf/qwen/qwen3.8-27b");
    assert.equal(o.reasoning_effort, "low");
    assert.deepEqual(o.chat_template_kwargs, { enable_thinking: false });
  });

  it("sends neither for a non-Qwen3 model", () => {
    assert.deepEqual(reasoningOpts("@cf/qwen/qwen2.5-coder-32b-instruct"), {});
    assert.deepEqual(reasoningOpts(undefined), {});
  });
});

describe("chat-vision — hasImage", () => {
  it("detects an image part anywhere in the history", () => {
    assert.equal(hasImage([{ role: "user", content: "plain" }]), false);
    assert.equal(hasImage([{ role: "user", content: [textPart("x"), imgPart()] }]), true);
    assert.equal(hasImage([]), false);
    assert.equal(hasImage(undefined), false);
  });
});

describe("chat-vision — data URL decoding", () => {
  it("decodes a valid base64 image data URL", () => {
    const d = decodeDataURL(DATA_URL);
    assert.ok(d);
    assert.equal(d.mediaType, "image/png");
    assert.equal(d.bytes.length, 70);
  });

  it("rejects non-data-URL and non-base64 input", () => {
    assert.equal(decodeDataURL("https://x/y.png"), null);
    assert.equal(decodeDataURL("data:image/png,notbase64"), null);
    assert.equal(decodeDataURL(""), null);
    assert.equal(decodeDataURL(null), null);
  });

  it("sha256Hex is a stable 64-hex digest (and never throws)", async () => {
    const { bytes } = decodeDataURL(DATA_URL);
    const a = await sha256Hex(bytes);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, await sha256Hex(bytes));
  });
});

describe("chat-vision — imageParts allow-list + size cap", () => {
  it("keeps allowed types and drops everything else", () => {
    const msg = { role: "user", content: [textPart("x"), imgPart(), imgPart("data:image/gif;base64,R0lGOD")] };
    const parts = imageParts(msg);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].mediaType, "image/png");
  });

  it("ignores assistant turns (only the user uploads)", () => {
    assert.deepEqual(imageParts({ role: "assistant", content: [imgPart()] }), []);
  });

  it("drops an image above the decoded size cap", () => {
    const big = "data:image/png;base64," + "A".repeat(Math.ceil((MAX_IMAGE_BYTES + 16) / 3) * 4);
    assert.deepEqual(imageParts({ role: "user", content: [imgPart(big)] }), []);
  });

  it("the allow-list is exactly png/jpeg/webp", () => {
    assert.deepEqual([...IMAGE_TYPES].sort(), ["image/jpeg", "image/png", "image/webp"]);
  });
});

describe("chat-vision — persistAttachments (R2 bytes + D1 metadata)", () => {
  function fakeEnv() {
    const puts = [];
    const rows = [];
    const env = {
      CHAT_MEDIA: { put: async (k, b, o) => { puts.push({ k, len: b.length, type: o?.httpMetadata?.contentType }); } },
      DB: {
        prepare: (sql) => ({
          _sql: sql, _a: [],
          bind(...a) { this._a = a; return this; },
          async run() { rows.push({ sql: this._sql, args: this._a }); return {}; },
        }),
      },
    };
    return { env, puts, rows };
  }

  it("puts the bytes in R2 and one metadata row in D1 (never the blob)", async () => {
    const { env, puts, rows } = fakeEnv();
    const saved = await persistAttachments(env, {
      sessionId: "chat_1_abc",
      messages: [{ id: "msg-uuid-1", role: "user", content: [textPart("chart?"), imgPart()] }],
      nowMs: Date.UTC(2026, 9, 14),
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].messageId, "msg-uuid-1");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].len, 70);
    assert.equal(puts[0].type, "image/png");
    assert.ok(puts[0].k.startsWith("chat/chat_1_abc/msg-uuid-1/"));
    assert.equal(rows.length, 1);
    assert.match(rows[0].sql, /INSERT INTO chat_attachments/);
    // r2_key is stored; the base64 payload is NOT part of the row.
    assert.ok(rows[0].args.includes(puts[0].k));
    assert.ok(!JSON.stringify(rows[0].args).includes("iVBORw0KGgo"));
  });

  it("mints a message id when the turn has none", async () => {
    const { env, rows } = fakeEnv();
    const saved = await persistAttachments(env, { sessionId: "s", messages: [{ role: "user", content: [imgPart()] }] });
    assert.match(saved[0].messageId, /^msg_/);
    assert.equal(rows[0].args[1], saved[0].messageId);
  });

  it("is a no-op for a text-only turn", async () => {
    const { env, puts, rows } = fakeEnv();
    const saved = await persistAttachments(env, { sessionId: "s", messages: [{ role: "user", content: "no image" }] });
    assert.deepEqual(saved, []);
    assert.equal(puts.length, 0);
    assert.equal(rows.length, 0);
  });

  it("exposes the vision model default used when AI_VISION_MODEL is unset", () => {
    assert.match(VISION_MODEL_DEFAULT, /^@cf\/qwen\//);
  });
});
