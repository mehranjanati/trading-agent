// market-bridge.mjs — market data the Worker cannot read itself.
//
// WHY THIS EXISTS (2026-11-08): Toobit answers HTTP 403 to Cloudflare's egress
// (the Worker) while the SAME endpoints answer 200 from the Go plane on Render
// — verified live: `POST /analyze` returned `data_source: "toobit-rest"` with a
// real last price in the same minute the Worker was being refused. The
// consequence on the dashboard was exactly what ADR-004's D1 fallback could not
// fix: `GET /api/symbols` collapsed onto four symbols (the ACTIVE allowlist +
// whatever watches/positions had seen) and `GET /api/prices` answered
// `prices: {}` with every symbol in `missing[]` — a desk with no catalog to
// search and no number to show.
//
// So the Worker keeps its venue-first read (cheapest and direct when the venue
// answers Cloudflare) and, ONLY when that fails, asks the platform's own second
// egress: `GET <go-watcher>/api/market/symbols` and `.../api/market/prices`.
// This is not a fourth third party (ADR-004 alternative D stays deferred); it
// is our own plane reading the same venue, so the numbers are the same venue's
// numbers and `source: "go-watcher"` is what every caller labels them with.
//
// Every function here is fail-soft and returns `null` rather than throwing: the
// caller is already on a degraded path and must never be handed a second
// failure it has to handle.
import { DEFAULT_WATCHER_URL } from "./proxy.mjs";

/** Bounded so a dead plane can never hang the caller. 30s is deliberate — the
 *  Go plane budgets itself at 25s (2026-11-12: the full ticker list alone
 *  measured 9.2s live, and the old 12s bridge deadline sat just above the
 *  plane's old 9s budget, so a slow venue minute was cut off a second before
 *  the answer arrived). The gap stays the caller's margin over the plane. */
export const MARKET_TIMEOUT_MS = 30_000;

/** watcherMarketBase — the Go-plane origin, or null when the operator
 *  explicitly disabled the handoff (`GO_WATCHER_URL = ""`). Mirrors
 *  proxy.mjs: the committed var and the baked-in default are the same host,
 *  so the two callers can never drift onto different bases. */
export function watcherMarketBase(env) {
  const raw = env?.GO_WATCHER_URL;
  if (raw === "") return null; // explicit opt-out for an env with no Go plane
  const base = String(raw ?? DEFAULT_WATCHER_URL).replace(/\/+$/, "");
  return base || null;
}

async function getJson(url, { timeoutMs = MARKET_TIMEOUT_MS, fetchFn = fetch } = {}) {
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

/** parseMarketSymbols — the Go plane's catalog answer as a string[].
 *  Anything that is not an array of non-empty strings is an empty list: the
 *  caller validates the FORM (SYMBOL_RE) itself, so this only decodes. */
export function parseMarketSymbols(body) {
  const list = Array.isArray(body?.symbols) ? body.symbols : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** parseMarketPrices — the Go plane's quote answer as `{prices, missing}`.
 *  `prices` is keyed by symbol with the provider attached (`src`, so a D1
 *  snapshot written from this path can name where the number came from), and
 *  every row the Go plane could not answer stays in `missing` — never invented. */
export function parseMarketPrices(body) {
  const rows = Array.isArray(body?.prices) ? body.prices : [];
  const prices = {};
  for (const r of rows) {
    const symbol = String(r?.symbol ?? "").trim().toUpperCase();
    const px = String(r?.px ?? "");
    if (!symbol || !px) continue;
    prices[symbol] = { px, src: String(r?.src ?? "go-watcher"), stale: r?.stale === true };
  }
  const missing = (Array.isArray(body?.missing) ? body.missing : [])
    .map((s) => String(s ?? "").trim().toUpperCase())
    .filter(Boolean);
  return { prices, missing };
}

/** fetchMarketSymbols — the venue catalog via the Go plane, or null.
 *  Never throws: a blocked/absent plane is "no second egress", which the
 *  caller treats exactly like a venue failure. */
export async function fetchMarketSymbols(env, { fetchFn = fetch, timeoutMs = MARKET_TIMEOUT_MS } = {}) {
  const base = watcherMarketBase(env);
  if (!base) return null;
  try {
    const res = await getJson(`${base}/api/market/symbols`, { timeoutMs, fetchFn });
    if (res?.status !== 200) return null;
    const symbols = parseMarketSymbols(res.body);
    return symbols.length ? symbols : null;
  } catch {
    return null;
  }
}

/** fetchMarketPrices — quotes for `symbols` via the Go plane, or null.
 *  The Go side caps a call at 25 symbols (workers/src/quotes.mjs MAX_FILTERED),
 *  so a longer list is refused here instead of being truncated silently — a
 *  truncated request would report the leftovers as "missing" when they were
 *  never asked for. */
export const MAX_BRIDGE_SYMBOLS = 25;

export async function fetchMarketPrices(env, symbols, { fetchFn = fetch, timeoutMs = MARKET_TIMEOUT_MS } = {}) {
  const base = watcherMarketBase(env);
  const wanted = (symbols ?? []).map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean);
  if (!base || !wanted.length) return null;
  if (wanted.length > MAX_BRIDGE_SYMBOLS) return null;
  try {
    const res = await getJson(`${base}/api/market/prices?symbols=${encodeURIComponent(wanted.join(","))}`, { timeoutMs, fetchFn });
    if (res?.status !== 200) return null;
    const parsed = parseMarketPrices(res.body);
    return Object.keys(parsed.prices).length ? parsed : null;
  } catch {
    return null;
  }
}
