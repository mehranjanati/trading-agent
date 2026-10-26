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
import { priceUrl, parseQuotes, sharedWindow, REST_BASE, PRICE_PATH } from "./fallback-poll.mjs";
import { SYMBOL_RE } from "./symbols.mjs";

export const MAX_FILTERED = 25;   // per-call cap on the per-symbol filtered mode
export const FULL_TTL_MS = 5_000; // in-isolate cache for the whole-venue answer

// Module scope: one isolate-wide cache, shared by every concurrent dashboard client.
let fullCache = { at_ms: 0, prices: {}, stale: false };

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
    const missing = [];
    for (const symbol of wanted) {
      window.spend(nowMs, 1);
      let res = null;
      try {
        res = await getJson(priceUrl(baseUrl, symbol), 4_000, fetchFn);
      } catch { res = null; }
      const rows = res?.status === 200 ? parseQuotes(res.body, [symbol], { venueForm: true }) : [];
      const row = rows.find((r) => r.symbol === symbol);
      if (row) prices[symbol] = String(row.price);
      else missing.push(symbol);
    }
    return { mode: "filtered", prices, missing, at };
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
      return { mode: "full", prices, missing: [], stale: false, cached: false, at };
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
