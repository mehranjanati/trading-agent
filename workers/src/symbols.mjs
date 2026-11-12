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
// Fail-soft in FOUR layers, because a third party must never be able to blank
// the UI:
//   1. KV cache (env.SYMBOLS_KV) — survives isolates; requires the binding
//   2. in-isolate memory cache — the fallback for --local/tests without KV
//   3. the GO PLANE (go-watcher /api/market/symbols) — the platform's own second
//      egress, which the venue DOES answer when Cloudflare's is 403'd
//   4. D1 (the ACTIVE allowlist + symbols already seen in watches/positions) —
//      answered with `stale:true` + `degraded:<reason>` + `source:"d1"`
// 2026-11-07: Toobit answered HTTP 403 to Cloudflare egress (200 from a laptop
// for the same URL); 2026-11-08 it was still refusing, so layer 3 is what keeps
// the picker usable — layer 4 alone listed four symbols out of ~773 markets.
// A total miss still answers 200 with an explicit `degraded` reason rather than
// a 503 — see listSymbols. The allowlist of the ACTIVE strategy_configs version
// rides along so the UI can badge "tradeable now" vs "venue-only".
import { fetchMarketSymbols } from "./market-bridge.mjs";

export const SYMBOLS_PATH = "/quote/v1/contract/ticker/price";
export const OKX_SYMBOLS_PATH = "/api/v5/public/instruments?instType=SWAP";
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
    // Futures rows carry the `-SWAP-` infix. A dash-free (canonical) row from a
    // Toobit ticker is the SPOT book (TOOBIT-API-FACTS S4), so it must never
    // enter the tradeable universe — even if the endpoint ever changes shape.
    if (!String(raw).toUpperCase().includes("-SWAP-")) continue;
    const symbol = canonicalSymbol(raw);
    if (!SYMBOL_RE.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  out.sort();
  return out;
}

export function symbolsCacheKey() { return "symbols:cache"; }

/** parseOkxSymbols — the second venue's catalog (ADR-004 alternative D,
 *  activated 2026-11-12): OKX `instruments?instType=SWAP` rows in the form
 *  `BTC-USDT-SWAP`, live only, USDT-margined. The canonical form falls out of
 *  the same canonicalSymbol rule the venue path uses (dashes removed, SWAP
 *  removed), and bridgeCatalog enforces the repo-wide SYMBOL_RE universe so an
 *  OKX-only listing can never widen the tradeable set. */
export function parseOkxSymbols(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const raws = [];
  for (const r of rows) {
    const instId = String(r?.instId ?? "");
    if (!instId.endsWith("-USDT-SWAP")) continue; // coin-margined (…-USD-SWAP) stays out
    if (r?.state && r.state !== "live") continue; // pre-open / suspended rows stay out
    raws.push(instId);
  }
  return bridgeCatalog(raws);
}

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

/** d1Symbols — the symbol set the PLATFORM already knows, read from D1.
 *
 *  WHY IT IS THE LAST LINE OF DEFENCE: on 2026-11-07 the venue answered
 *  HTTP 403 to the Worker's Cloudflare egress IP (verified: the same request
 *  from a laptop returned 200), which blanked the whole symbol picker with a
 *  503. Every symbol the platform actually trades is already recorded here —
 *  the ACTIVE risk allowlist, every watch ever armed, every position held — and
 *  D1 is inside Cloudflare, so no third party can make this list unreachable.
 *  It is a FALLBACK, not a replacement: it can only ever list symbols we have
 *  seen before, which is exactly what an operator needs when the venue list is
 *  unavailable. Never throws. */
export async function d1Symbols(env) {
  const out = new Set();
  for (const s of await activeAllowlist(env)) out.add(s);
  if (env?.DB?.prepare) {
    for (const sql of ["SELECT DISTINCT symbol FROM watches", "SELECT symbol FROM positions"]) {
      try {
        const rows = (await env.DB.prepare(sql).all()).results ?? [];
        for (const r of rows) {
          const s = String(r?.symbol ?? "").toUpperCase().trim();
          if (SYMBOL_RE.test(s)) out.add(s);
        }
      } catch { /* a missing table is an empty contribution, never a failure */ }
    }
  }
  return [...out].sort();
}

/** GET /api/symbols — cached venue list + active allowlist. Never throws.
 *
 *  Egress order (2026-11-08): cache → venue → **Go plane** → stale cache → D1.
 *  The venue answers HTTP 403 to Cloudflare's egress while answering the Go
 *  plane, and without that second leg this route collapsed onto D1's four rows
 *  (ADR-004: "a single venue is a single point of failure for the CATALOG
 *  too"). The Go leg answers the SAME venue read, so `source: "go-watcher"`
 *  is a live catalog and not a fallback with an age to be ashamed of. */
export async function listSymbols(env, { fetchFn = fetch, nowMs = Date.now(), marketSymbols = fetchMarketSymbols } = {}) {
  const cached = await readCache(env);
  if (cached && nowMs - cached.at < SYMBOLS_TTL_MS) {
    return { symbols: cached.symbols, allowlist: await activeAllowlist(env), stale: false, source: cached.source, at: new Date(cached.at).toISOString() };
  }
  let venueError = null;
  try {
    const base = (env.TOOBIT_BASE ?? "https://api.toobit.com").replace(/\/$/, "");
    const res = await fetchFn(`${base}${SYMBOLS_PATH}`);
    if (!res.ok) throw new Error(`venue HTTP ${res.status}`);
    const symbols = parseSymbols(await res.json());
    if (!symbols.length) throw new Error("venue returned no symbols");
    const entry = { at: nowMs, symbols, stale: false, source: "toobit-rest" };
    await writeCache(env, entry);
    return { symbols, allowlist: await activeAllowlist(env), stale: false, at: new Date(nowMs).toISOString() };
  } catch (e) {
    venueError = e;
  }
  // Second venue (ADR-004 alternative D, activated 2026-11-12): OKX answers
  // where Toobit refuses Cloudflare egress, and — unlike the Go plane below —
  // it needs NO other machine to be awake: one direct fetch, cached like a
  // venue success. The universe rule (bridgeCatalog) is the same, so an
  // OKX-only listing can never widen the tradeable set beyond SYMBOL_RE.
  try {
    const okxBase = (env.OKX_BASE ?? "https://www.okx.com").replace(/\/$/, "");
    const res = await fetchFn(`${okxBase}${OKX_SYMBOLS_PATH}`);
    if (!res.ok) throw new Error(`okx HTTP ${res.status}`);
    const symbols = parseOkxSymbols(await res.json());
    if (!symbols.length) throw new Error("okx returned no symbols");
    // OKX's universe misses Toobit-only listings the platform already knows
    // (EVAAUSDT was watched on the venue but is not on OKX): union the D1 rows
    // back in so the picker keeps every symbol the venue itself served before.
    const merged = bridgeCatalog([...symbols, ...(await d1Symbols(env))]);
    await writeCache(env, { at: nowMs, symbols: merged, stale: false, source: "okx-rest" });
    return {
      symbols: merged,
      allowlist: await activeAllowlist(env),
      stale: false,
      source: "okx-rest",
      at: new Date(nowMs).toISOString(),
    };
  } catch (okxError) { /* the Go plane and the D1 fallback below still answer */ }

  // Second egress: our own Go plane reads the same venue from an IP the venue
  // does answer. It caches like a venue success (1h), so the fallback costs one
  // round-trip per TTL window, not one per dashboard poll.
  const bridged = await marketSymbols(env, { fetchFn }).catch(() => null);
  if (bridged?.length) {
    const symbols = bridgeCatalog(bridged);
    if (symbols.length) {
      await writeCache(env, { at: nowMs, symbols, stale: false, source: "go-watcher" });
      return {
        symbols,
        allowlist: await activeAllowlist(env),
        stale: false,
        source: "go-watcher",
        at: new Date(nowMs).toISOString(),
      };
    }
  }
  if (cached?.symbols?.length) {
    return { symbols: cached.symbols, allowlist: await activeAllowlist(env), stale: true, at: new Date(cached.at).toISOString() };
  }
  // No cache and the venue refused us. Throwing here turned a third-party
  // block into a 503 that blanked the dashboard's symbol picker, even though
  // the page's documented contract (dashboard/src/lib/symbols.ts) is "a total
  // failure answers with symbols:[] and stale:true, never a crash". So answer
  // with what the platform still knows (D1) and say WHY it is not the venue
  // list: `degraded` carries the venue error, `source` names the fallback.
  // Callers that need a hard failure read `degraded`, not a status code.
  const e = venueError;
  const allowlist = await activeAllowlist(env);
  const fallback = await d1Symbols(env);
  return {
    symbols: fallback,
    allowlist,
    stale: true,
    degraded: `venue unavailable: ${e?.message ?? e}`,
    source: "d1",
    at: new Date(nowMs).toISOString(),
  };
}

/** bridgeCatalog — the Go plane's catalog through the SAME form rules as the
 *  venue path, so a bridged list can never widen the universe: canonical
 *  SYMBOL_RE form only, deduped, sorted. A symbol the venue lists but the repo
 *  refuses (e.g. `1INCHUSDT`, which the regex rejects repo-wide) stays out
 *  whichever egress answered. */
export function bridgeCatalog(symbols) {
  const seen = new Set();
  const out = [];
  for (const raw of symbols ?? []) {
    const symbol = canonicalSymbol(raw);
    if (!SYMBOL_RE.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  out.sort();
  return out;
}
