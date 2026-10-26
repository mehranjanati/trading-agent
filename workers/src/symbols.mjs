// symbols.mjs — Toobit-backed tradeable symbol list (Workers proxy).
//
// WHY A PROXY: Toobit has no CORS allow for browser fetches and the raw
// full-ticker answer is ~61KB / ~1033 markets in the dash form
// (`BTC-SWAP-USDT`). The Worker fetches once, canonicalises to the repo-wide
// form (`BTCUSDT`, same as canonicalSymbol + normalize.ToCanonical), caches
// 1h, and answers the dashboard with a light array.
//
// THIS IS THE FUTURES UNIVERSE: the path is /quote/v1/contract/ticker/price and
// every row carries the `-SWAP-` infix (773 USDT-M + 10 USDC-M + test rows).
// `parseSymbols` keeps only `...USDT`, so the canonical `EDUUSDT` the dashboard
// shows is the USDT-M perpetual `EDU-SWAP-USDT`, never the spot market
// (TOOBIT-API-FACTS S4: the canonical form resolves to spot on the ticker paths).
//
// Weight discipline (ADR-004): ONE venue weight-1 request per cache miss,
// served from cache otherwise — the dashboard poll never touches the venue.
//
// Fail-soft: on any venue/parse failure the last-good cache answers with
// `stale: true`; only when no cache exists at all is 502 returned. The
// allowlist of the ACTIVE strategy_configs version rides along so the UI can
// badge "tradeable now" vs "venue-only".
export const SYMBOLS_PATH = "/quote/v1/contract/ticker/price";
export const SYMBOLS_TTL_MS = 3_600_000; // 1h — listings change rarely
export const SYMBOL_RE = /^[A-Z]{2,12}USDT$/;

/** Canonical symbol form (repo-wide): `BTC-SWAP-USDT` → `BTCUSDT`. Mirrors
 *  fallback-poll.mjs canonicalSymbol + go-watcher/normalize.ToCanonical
 *  exactly (dashes removed, SWAP substring removed) so both planes agree on
 *  one symbol identity. */
export function canonicalSymbol(raw) {
  return String(raw ?? "").toUpperCase().trim().replaceAll("-", "").replaceAll("SWAP", "");
}

/** Filter + dedupe the raw venue list into canonical tradeable symbols. */
export function parseSymbols(body) {
  const list = Array.isArray(body) ? body : (body?.data ?? []);
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const raw = r?.s ?? r?.symbol;
    if (!raw) continue;
    const symbol = canonicalSymbol(raw);
    if (!SYMBOL_RE.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  out.sort();
  return out;
}

export function symbolsCacheKey() { return "symbols:cache"; }

/** In-memory fallback when env.SYMBOLS_KV is absent (tests, --local). */
const memCache = { at: 0, symbols: [], stale: false };

async function readCache(env) {
  // KV (when bound) is the source of truth across isolates: a miss means a
  // genuinely cold cache, NEVER the memory of a different isolate/test.
  // Memory is only the fallback for --local/tests without a KV binding.
  if (env.SYMBOLS_KV) {
    try {
      const raw = await env.SYMBOLS_KV.get(symbolsCacheKey());
      if (raw) return JSON.parse(raw);
    } catch { /* a KV read error degrades to cold, not to stale memory */ }
    return null;
  }
  return memCache.at ? { ...memCache } : null;
}

async function writeCache(env, entry) {
  Object.assign(memCache, entry);
  try {
    if (env.SYMBOLS_KV) {
      await env.SYMBOLS_KV.put(symbolsCacheKey(), JSON.stringify(entry));
    }
  } catch { /* memory already holds it */ }
}

/** Tradeable set of the ACTIVE strategy_configs version (may be empty). */
export async function activeAllowlist(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT config_json FROM strategy_configs ORDER BY at DESC LIMIT 1",
    ).all();
    const cfg = JSON.parse(row.results?.[0]?.config_json ?? "{}");
    return Array.isArray(cfg.allowlist) ? cfg.allowlist.filter((s) => SYMBOL_RE.test(s)) : [];
  } catch { return []; }
}

/** GET /api/symbols — cached venue list + active allowlist. Never throws. */
export async function listSymbols(env, { fetchFn = fetch, nowMs = Date.now() } = {}) {
  const cached = await readCache(env);
  if (cached && nowMs - cached.at < SYMBOLS_TTL_MS) {
    return { symbols: cached.symbols, allowlist: await activeAllowlist(env), stale: false, at: new Date(cached.at).toISOString() };
  }
  try {
    const base = (env.TOOBIT_BASE ?? "https://api.toobit.com").replace(/\/$/, "");
    const res = await fetchFn(`${base}${SYMBOLS_PATH}`);
    if (!res.ok) throw new Error(`venue HTTP ${res.status}`);
    const symbols = parseSymbols(await res.json());
    if (!symbols.length) throw new Error("venue returned no symbols");
    const entry = { at: nowMs, symbols, stale: false };
    await writeCache(env, entry);
    return { symbols, allowlist: await activeAllowlist(env), stale: false, at: new Date(nowMs).toISOString() };
  } catch (e) {
    if (cached?.symbols?.length) {
      return { symbols: cached.symbols, allowlist: await activeAllowlist(env), stale: true, at: new Date(cached.at).toISOString() };
    }
    const err = new Error(`symbols unavailable: ${e?.message ?? e}`);
    err.code = "DEGRADED";
    throw err;
  }
}
