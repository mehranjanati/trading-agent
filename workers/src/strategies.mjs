// strategies.mjs — E07-T01-S2a/S2b: versioned strategy configs + HMAC webhook.
//
// S2a (activation + pinning): the active strategy version is an ordinary config
// row selected by the newest `at` marker; an analysis run pins the version that
// was active AT RUN START, so old runs keep v1 forever (pin-immutability).
// S2b (provenance): webhook payloads are HMAC-SHA256 authenticated with a
// constant-time compare, replay-protected by nonce, and freshness-checked
// (30s clock skew, per docs/07 §7.4). Provenance proves the source's identity —
// never the strategy's validity. That decision belongs to the R-gates (E08).
export const CLOCK_SKEW_MS = 30_000;
// Per-isolate nonce memory (replay protection). The Workers isolate is the
// right scope: a retried webhook within the skew window is caught here, and the
// durable audit lives in `recovery_log` / the signal row's deterministic id.
export const seenNonces = new Set();
// Keyed per source: env.SIGNAL_HMAC_SECRETS is a JSON map {source: secret} (or,
// for local/test, a single SIGNAL_HMAC_SECRET). Secrets come from the secret
// store (docs/ops/SECRET-STORE.md) — never from the request.
export function secretsFor(env) {
  if (env.SIGNAL_HMAC_SECRETS) {
    try {
      const m = JSON.parse(env.SIGNAL_HMAC_SECRETS);
      if (m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).length) return m;
    } catch { /* fall through to the single-secret form */ }
  }
  return env.SIGNAL_HMAC_SECRET ? { "__default__": env.SIGNAL_HMAC_SECRET } : {};
}

// The allowlist is config, extensible without code: by default the D1-backed
// registry row (`signal_sources` component of the active strategy config);
// callers may pass an explicit table (tests do exactly that).
export function allowlistFor(configJson = {}) {
  return (configJson && configJson.signal_sources) || {};
}
export function sourceAllowed(allowlist, kind, source) {
  const kinds = allowlist?.[source];
  return Array.isArray(kinds) && kinds.includes(kind);
}

const te = new TextEncoder();
async function hmacHex(secret, bytes) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, bytes);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = te.encode(a.toLowerCase());
  const y = te.encode(b.toLowerCase());
  if (x.length !== y.length || x.length !== 64) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** Signed envelope: the caller posts timestamp_ms + nonce + the signal body.
 *  The signature covers `timestamp_ms + "." + nonce + "." + rawBody`. */
export async function signWebhook(secret, { timestamp_ms, nonce, rawBody }) {
  return hmacHex(secret, te.encode(`${timestamp_ms}.${nonce}.${rawBody}`));
}

/** Verify a webhook call. Throws `{ code: "WEBHOOK", reason }` on any failure;
 *  success returns the resolved source. Checks in order: envelope fields →
 *  clock skew → known source secret → constant-time signature → nonce replay. */
export async function verifyWebhook(env, headers, rawBody, { store } = {}) {
  const get = (k) => headers?.get?.(k) ?? headers?.[k];
  const timestamp = Number(get("x-signal-timestamp") ?? NaN);
  const nonce = String(get("x-signal-nonce") ?? "");
  const signature = String(get("x-signal-signature") ?? "");
  const source = String(get("x-signal-source") ?? "");
  const fail = (reason) => {
    const e = new Error(`webhook rejected: ${reason}`);
    e.code = "WEBHOOK";
    e.reason = reason;
    throw e;
  };
  if (!source || !nonce || !signature || !Number.isFinite(timestamp)) fail("envelope");
  const now = Date.now();
  if (Math.abs(now - timestamp) > CLOCK_SKEW_MS) fail("stale");
  const secret = secretsFor(env)[source] ?? secretsFor(env).__default__;
  if (!secret) fail("unknown-source");
  const expect = await signWebhook(secret, { timestamp_ms: timestamp, nonce, rawBody });
  if (!safeEqualHex(expect, signature)) fail("bad-signature");
  const st = store ?? seenNonces;
  if (typeof st.has === "function" ? st.has(nonce) : st.includes(nonce)) fail("replay");
  if (typeof st.add === "function") st.add(nonce);
  else if (typeof st.push === "function") st.push(nonce);
  return { source };
}

/** Version registry on the existing `strategy_configs` table. Activation is an
 *  explicit operator row (never an overwrite): the active version is the row
 *  with the newest `at`. Runs pin via `output_json.strategy_version`. */
export async function activeVersion(env) {
  const row = await env.DB.prepare(
    "SELECT version, config_json, at FROM strategy_configs ORDER BY at DESC LIMIT 1",
  ).all().catch(() => ({ results: [] }));
  return row.results?.[0] ?? null;
}
export async function activateVersion(env, { version, config, actor }) {
  const now = new Date().toISOString();
  const body = typeof config === "string" ? config : JSON.stringify(config ?? {});
  JSON.parse(body); // reject non-JSON configs before they can freeze a version
  await env.DB.prepare(
    "INSERT INTO strategy_configs(version, config_json, activated_by, at) VALUES(?,?,?,?)",
  ).bind(version, body, actor, now).run();
  return { version, activated_by: actor, at: now };
}
