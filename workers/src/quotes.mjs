// quotes.mjs — GET /api/prices: the live venue quote the dashboard reads.
//
// WHY THIS EXISTS: the setup rooms (/setups/<SYM>) show lifecycle records only
// (watches, approvals, orders, runs) — no price anywhere — because Toobit has no
// browser CORS and the Worker exposed no quote route. This module surfaces the
// SAME futures ticker the poller reads, with the same fail-closed rules:
//
// 1. The symbol FORM selects the book: a filtered request must send the venue
//    form (`BTC-SWAP-USDT`) and a canonical echo is the SPOT book — refused
//    (`parseQuotes(..., { venueForm: true })`, TOOBIT-API-FACTS S4).
// 2. `?symbols=` is IGNORED by the venue, so a filtered read is ONE weight-1
//    request per symbol (the ADR-004 math). The no-param mode answers the whole
//    venue in one weight-1 unfiltered request (the shape symbols.mjs reads),
//    cached briefly in-isolate so a burst of dashboard clients costs one venue
//    hit per TTL window.
// 3. Weight discipline: every request spends the shared ADR-004 window with the
//    poller, so the dashboard can never silently walk the venue into a 429.
// 4. A refused venue is not a blank desk (2026-11-08): the symbols the venue
//    would not answer are re-asked over the platform's OWN second egress
//    (go-watcher /api/market/prices, see market-bridge.mjs) before the D1
//    last-known-price layer is consulted. Only the no-param full mode has no
//    bridge — no dashboard surface calls it (ADR-004).
import { priceUrl, parseQuotes, sharedWindow, REST_BASE, PRICE_PATH } from "./fallback-poll.mjs";
import { SYMBOL_RE } from "./symbols.mjs";
import { fetchMarketPrices } from "./market-bridge.mjs";

export const MAX_FILTERED = 25;   // per-call cap on the per-symbol filtered mode
export const FULL_TTL_MS = 5_000; // in-isolate cache for the whole-venue answer
/** SNAPSHOT_WRITE_MS throttles the D1 write of the last-known price per symbol:
 *  the cockpit polls every 15s and the venue rarely moves a row's purpose, so
 *  one upsert a minute per symbol keeps the fallback warm without turning a
 *  read path into a write storm. */
export const SNAPSHOT_WRITE_MS = 60_000;

// Module scope: one isolate-wide cache, shared by every concurrent dashboard client.
let fullCache = { at_ms: 0, prices: {}, stale: false };
// Per-symbol throttle clock for the D1 snapshot write (isolate-local is fine:
// a cold isolate simply writes one extra row).
let snapshotAt = new Map();

/** readSnapshots — the last price we actually SAW for these symbols (D1).
 *
 *  WHY: on 2026-11-07 the venue answered HTTP 403 to the Worker's Cloudflare
 *  egress IP (200 from a laptop, same URL) and /api/prices returned
 *  `prices: {}` with every symbol "missing" — a desk with no number at all. A
 *  price we observed is honest data as long as it is labelled stale with its
 *  age, and D1 lives inside Cloudflare, so no third party can blank it.
 *  Never throws: a missing table/binding is simply "no fallback". */
export async function readSnapshots(env, symbols, { nowMs = Date.now() } = {}) {
  const out = {};
  const wanted = (symbols ?? []).filter((s) => SYMBOL_RE.test(String(s ?? "")));
  if (!env?.DB?.prepare || !wanted.length) return out;
  try {
    const ph = wanted.map(() => "?").join(",");
    const rows = (await env.DB.prepare(
      `SELECT symbol,px,at FROM price_snapshots WHERE symbol IN (${ph})`,
    ).bind(...wanted).all()).results ?? [];
    for (const r of rows) {
      const symbol = String(r?.symbol ?? "").toUpperCase().trim();
      const px = String(r?.px ?? "");
      if (!SYMBOL_RE.test(symbol) || !px) continue;
      const at = String(r?.at ?? "");
      const ageMs = at ? Math.max(0, nowMs - Date.parse(at)) : null;
      out[symbol] = { px, at, ageMs: Number.isFinite(ageMs) ? ageMs : null };
    }
  } catch { /* absent table/DB -> no fallback, never a failure */ }
  return out;
}

/** persistSnapshots — record what the venue just told us, throttled and
 *  fail-soft. This is a CACHE for the fallback path: no order, approval or risk
 *  decision may read it (D-08 unchanged). */
export async function persistSnapshots(env, prices, { nowMs = Date.now(), src = "toobit-rest" } = {}) {
  if (!env?.DB?.prepare) return 0;
  const at = new Date(nowMs).toISOString();
  const rows = [];
  for (const [symbol, px] of Object.entries(prices ?? {})) {
    if (!SYMBOL_RE.test(symbol) || typeof px !== "string" || !px) continue;
    // A symbol with NO recorded write must never be throttled: comparing against
    // a 0 default makes any timestamp below the window look "recent" and silently
    // drops the very first snapshot.
    const last = snapshotAt.get(symbol);
    if (last !== undefined && nowMs - last < SNAPSHOT_WRITE_MS) continue;
    rows.push([symbol, px, src, at]);
  }
  if (!rows.length) return 0;
  try {
    const stmts = rows.map((r) => env.DB.prepare(
      "INSERT INTO price_snapshots(symbol,px,src,at) VALUES(?,?,?,?) " +
      "ON CONFLICT(symbol) DO UPDATE SET px=excluded.px, src=excluded.src, at=excluded.at",
    ).bind(...r));
    if (typeof env.DB.batch === "function") await env.DB.batch(stmts);
    else for (const s of stmts) await s.run();
    for (const r of rows) snapshotAt.set(r[0], nowMs);
    return rows.length;
  } catch { return 0; }
}

/** test hook: forget the snapshot write throttle between cases. */
export function resetSnapshotThrottle() { snapshotAt = new Map(); }

async function getJson(url, timeoutMs = 4_000, fetchFn = fetch) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

const badSymbol = (s) => Object.assign(new Error(`bad symbol ${s}`), { code: "VALIDATION" });

/** GET /api/prices — `?symbols=A,B,C` answers those symbols (one weight-1 filtered
 *  request each, ≤ MAX_FILTERED); no param answers the whole venue from one
 *  weight-1 request (5s in-isolate cache, stale-served on venue failure).
 *  Never throws for data reasons — unanswered symbols land in `missing`. */
export async function listPrices(env, { url, fetchFn = fetch, nowMs = Date.now(), window = sharedWindow, baseUrl = REST_BASE } = {}) {
  const raw = url?.searchParams?.get("symbols") ?? "";
  const wanted = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  for (const s of wanted) if (!SYMBOL_RE.test(s)) throw badSymbol(s);
  const at = new Date(nowMs).toISOString();

  // Filtered mode: one venue-form request per symbol, exactly like the poller.
  if (wanted.length) {
    if (wanted.length > MAX_FILTERED) {
      throw Object.assign(new Error(`too many symbols (${wanted.length}) — max ${MAX_FILTERED} per call`), { code: "VALIDATION" });
    }
    const weight = wanted.length; // 1 per symbol
    if (!window.canSpend(nowMs, weight)) {
      throw Object.assign(new Error(`price budget exhausted (need ${weight})`), { code: "RATE" });
    }
    const prices = {};
    let missing = [];
    let venueError = null;
    for (const symbol of wanted) {
      window.spend(nowMs, 1);
      let res = null;
      try {
        res = await getJson(priceUrl(baseUrl, symbol), 4_000, fetchFn);
      } catch (e) {
        res = null;
        venueError = venueError ?? `venue unreachable: ${e?.message ?? e}`;
      }
      if (res && res.status !== 200) venueError = venueError ?? `venue HTTP ${res.status}`;
      const rows = res?.status === 200 ? parseQuotes(res.body, [symbol], { venueForm: true }) : [];
      const row = rows.find((r) => r.symbol === symbol);
      if (row) prices[symbol] = String(row.price);
      else missing.push(symbol);
    }
    // What the venue just told us is worth recording: it is the only thing that
    // can answer the NEXT request when the venue blocks us.
    await persistSnapshots(env, prices, { nowMs });

    // Second egress (2026-11-08): the Go plane reads the SAME venue from an IP
    // Toobit does answer while it 403s Cloudflare. Without this leg a blocked
    // venue left the desk with NO number at all — `prices: {}` and every symbol
    // "missing" — because D1 had never seen one either. Only the symbols the
    // venue just refused travel over the bridge, so the venue keeps first say
    // (and the ADR-004 weight window keeps counting what actually went there).
    const bridged = [];
    if (missing.length) {
      const hit = await fetchMarketPrices(env, missing, { fetchFn }).catch(() => null);
      if (hit) {
        const filled = {};
        for (const [symbol, row] of Object.entries(hit.prices)) {
          if (!SYMBOL_RE.test(symbol) || prices[symbol]) continue;
          prices[symbol] = row.px;
          filled[symbol] = row.px;
          bridged.push(symbol);
        }
        if (bridged.length) {
          await persistSnapshots(env, filled, { nowMs, src: "go-watcher" });
          missing = missing.filter((s) => prices[s] === undefined);
        }
      }
    }

    // Venue-block fallback (ADR-004): a symbol we could not read live but have
    // SEEN before is served from D1 — labelled stale, with the observation age —
    // instead of vanishing from the desk. `missing` keeps only what we have
    // never seen at all, so a caller can still tell "no idea" from "stale".
    const staleSymbols = [];
    if (missing.length) {
      const snaps = await readSnapshots(env, missing, { nowMs });
      for (let i = missing.length - 1; i >= 0; i--) {
        const symbol = missing[i];
        const snap = snaps[symbol];
        if (!snap) continue;
        prices[symbol] = snap.px;
        staleSymbols.push(symbol);
        missing.splice(i, 1);
      }
      staleSymbols.reverse();
    }
    // `source` names the egress that answered: D1 = last-known (stale, aged),
    // go-watcher = live venue data read by our own plane, venue = direct.
    const source = staleSymbols.length ? "d1" : bridged.length ? "go-watcher" : "venue";
    return {
      mode: "filtered", prices, missing, at,
      stale: staleSymbols.length > 0,
      source,
      ...(staleSymbols.length ? { stale_symbols: staleSymbols } : {}),
      ...(bridged.length ? { bridged_symbols: bridged } : {}),
      // Nothing answered at all: say WHY, instead of an empty object that reads
      // like "the venue has no price for this symbol".
      ...(!Object.keys(prices).length && venueError ? { degraded: venueError } : {}),
    };
  }

  // Full mode: ONE unfiltered weight-1 request answers every venue market.
  if (nowMs - fullCache.at_ms < FULL_TTL_MS && Object.keys(fullCache.prices).length) {
    return { mode: "full", prices: fullCache.prices, missing: [], stale: false, cached: true, at };
  }
  const weight = 1;
  if (!window.canSpend(nowMs, weight)) {
    // Budget is exhausted: a fresh-enough cache is honest data, an empty one is not.
    if (Object.keys(fullCache.prices).length) {
      return { mode: "full", prices: fullCache.prices, missing: [], stale: nowMs - fullCache.at_ms >= FULL_TTL_MS, cached: true, at };
    }
    throw Object.assign(new Error("price budget exhausted"), { code: "RATE" });
  }
  window.spend(nowMs, weight);
  let res = null;
  try {
    res = await getJson(`${String(baseUrl).replace(/\/$/, "")}${PRICE_PATH}`, 8_000, fetchFn);
  } catch { res = null; }
  if (res?.status === 200) {
    const prices = {};
    for (const q of parseQuotes(res.body, null, { venueForm: true })) prices[q.symbol] = q.price;
    if (Object.keys(prices).length) {
      fullCache = { at_ms: nowMs, prices, stale: false };
      await persistSnapshots(env, prices, { nowMs });
      return { mode: "full", prices, missing: [], stale: false, cached: false, at, source: "venue" };
    }
  }
  // Venue unreachable: serve the stale cache when it exists, fail closed otherwise.
  if (Object.keys(fullCache.prices).length) {
    return { mode: "full", prices: fullCache.prices, missing: [], stale: true, cached: true, at };
  }
  throw Object.assign(new Error("venue unreachable and no cached prices"), { code: "DEGRADED" });
}

/** Test hook: reset the in-isolate full cache between tests. */
export function resetFullCache() {
  fullCache = { at_ms: 0, prices: {}, stale: false };
}
