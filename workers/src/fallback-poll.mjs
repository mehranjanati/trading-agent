// fallback-poll.mjs — E06-T02-S3c: ADR-004 rate-limited REST fallback poller (Workers).
//
// Budget (A-02 / ADR-004): REQUEST_WEIGHT 3000/min ≈ 50/s; the price endpoint costs 1
// weight per symbol; the chosen cadence is 5s and the adequacy floor is
// `symbols x 1/50 x 2` seconds. Every round is budget-guarded BEFORE it is sent, so the
// limiter drops a round rather than spend into a 429. A 429 (or a body carrying
// X-Api-Limit-Reset-Timestamp) → backoff + the `rate_limit_backoff` incident, which is
// the ADR-004 alert ("alert if this ever fires").
//
// No egress from this machine (go-watcher/SOAK-NOTE.md): the live 429-free run is
// deferred to Hetzner/E12 and attaches to the E11 gate report. The proof here is the
// stub exchange (scripts/stub-exchange.mjs), driven by fallback-poll.test.mjs and by
// `chaos.mjs budget`.
//
// Cadence: ADR-004 asks for 5s; the cron fires every 10s and the production 5s cadence
// arrives with the DO alarm (E12). `tick(nowMs)` takes time as an argument, so tests and
// drills drive an exact 5s cadence deterministically.
import { recordIncident } from "./_shared.mjs";
import { TH } from "./health.mjs";

export const REST_BASE = "https://api.toobit.com";
export const PRICE_PATH = "/quote/v1/contract/ticker/price"; // weight 1 per symbol
export const BUDGET_PER_MIN = 3000;
export const BUDGET_PER_SEC = 50;
export const POLL_MS = 5_000;             // ADR-004 chosen poll interval
export const POLL_WEIGHT = 1;             // weight per symbol on the price endpoint
export const MAX_BACKOFF_MS = 60_000;
export const POLL_RETRIES = 1;            // one retry per symbol: a cold TLS handshake after
                                          // the idle gap can exceed the per-request timeout
export const RETRY_MS = 300;
export const POLL_ID = "poll_quotes";     // fixed id → the status row never grows
export const TOP_N_DEFAULT = 10;          // §6.2 S3 minimal top-N watch set
export const RESET_HEADER = "x-api-limit-reset-timestamp";
export const BACKOFF_INCIDENT = "rate_limit_backoff";
export const TOOBIT_LIMIT_CODES = [-1003, -1015]; // TOO_MANY_REQUESTS / TOO_MANY_ORDERS

/** ADR-004 adequacy floor in ms: symbols x 1/50 x 2 seconds between rounds. */
export function floorMs(symbols, budgetPerSec = BUDGET_PER_SEC) {
  return Math.ceil((symbols / budgetPerSec) * 2 * 1000);
}

/** Rolling-window weight guard. Toobit accounts per minute, so a rolling window models
 *  it better than a leaky bucket, and `canSpend` is checked before every round. */
export function createWindow({ budget = BUDGET_PER_MIN, windowMs = 60_000 } = {}) {
  const hits = [];
  const prune = (nowMs) => { while (hits.length && nowMs - hits[0].at >= windowMs) hits.shift(); };
  const total = () => hits.reduce((n, h) => n + h.weight, 0);
  return {
    budget,
    windowMs,
    usage(nowMs) { prune(nowMs); return total(); },
    canSpend(nowMs, weight) { prune(nowMs); return total() + weight <= budget; },
    spend(nowMs, weight) { prune(nowMs); hits.push({ at: nowMs, weight }); return total(); },
  };
}

/** One shared window per isolate: the venue's limiter stays authoritative, this only
 *  keeps us from walking into a 429. Tests/drills inject a fresh window for exact math. */
export const sharedWindow = createWindow();

/** §6.2 S3 poll set: ACTIVE watches only, deterministic top-N by priority. The watch
 *  priority field lands with E07; until then the order is deterministic (oldest
 *  created_at first, then id) so drill expectations stay reproducible. */
export function pollSetSql(limit = TOP_N_DEFAULT) {
  return `SELECT symbol FROM watches WHERE status='ACTIVE' ORDER BY created_at, id LIMIT ${limit};`;
}

export async function pollSet(env, { limit = TOP_N_DEFAULT } = {}) {
  const rows = (await env.DB.prepare(pollSetSql(limit)).all()).results ?? [];
  return [...new Set(rows.map((r) => r.symbol))];
}

/** Canonical symbol form (repo-wide): `BTC-SWAP-USDT` → `BTCUSDT`. Mirrors the Go
 *  normalizer (go-watcher/normalize.ToCanonical) exactly — dashes and the SWAP infix
 *  are removed — so both planes agree on one symbol identity. */
export function canonicalSymbol(raw) {
  return String(raw ?? "").toUpperCase().trim().replaceAll("-", "").replaceAll("SWAP", "");
}

/** Venue (futures) form: `BTCUSDT` → `BTC-SWAP-USDT`. THE SYMBOL FORM SELECTS THE
 *  MARKET: Toobit answers `?symbol=BTCUSDT` from its SPOT book even on the
 *  /quote/v1/contract/... path, while `BTC-SWAP-USDT` is the USDT-M perpetual
 *  (verified 2026-10-26, TOOBIT-API-FACTS S4: BTCUSDT 80312.09 vs
 *  BTC-SWAP-USDT 80287.40 in the same second). Every futures REST read must send
 *  this form. Mirrors go-watcher/normalize.ToVenue. */
export function venueSymbol(symbol) {
  // Idempotent: canonicalise first, so an already-venue form cannot double-append.
  const s = canonicalSymbol(symbol);
  return /^[A-Z0-9]{2,12}USDT$/.test(s) ? `${s.slice(0, -4)}-SWAP-USDT` : s;
}

/** Request URL for one symbol. Live-verified 2026-10-11 (TOOBIT-API-FACTS S2a):
 *  `?symbol=` (singular) filters the answer, while `?symbols=...` is IGNORED and
 *  returns the whole venue (~1033 markets, 61KB, dash form). The poller therefore
 *  issues one weight-1 request per symbol — the ADR-004 math as written.
 *  2026-10-26 correction: the symbol is sent in the venue (dash) form so the
 *  answer is the FUTURES book, not spot (TOOBIT-API-FACTS S4). */
export function priceUrl(baseUrl, symbol) {
  return `${String(baseUrl).replace(/\/$/, "")}${PRICE_PATH}?symbol=${encodeURIComponent(venueSymbol(symbol))}`;
}

/** Parse the price endpoint. Accepted shapes: the futures filtered form
 *  `{"s":"BTC-SWAP-USDT","p":"83838"}` and the full-list dash form
 *  `{"s":"BTC-SWAP-USDT","si":...,"p":...}`. Symbols are canonicalised and, when
 *  `wanted` is given, anything outside the poll set is dropped — the venue's
 *  unfiltered answer must never leak into our quote snapshot.
 *
 *  `venueForm` is the fail-closed guard for the futures poll: a row WITHOUT the
 *  `-SWAP-` infix is the spot book (Toobit resolves the canonical form to spot,
 *  see venueSymbol) and must never be quoted as a futures price. */
export function parseQuotes(body, wanted = null, { venueForm = false } = {}) {
  const list = Array.isArray(body) ? body : (body?.data ?? []);
  const allow = wanted ? new Set(wanted.map(canonicalSymbol)) : null;
  const out = [];
  for (const r of list) {
    const raw = r?.s ?? r?.symbol;
    const price = r?.p ?? r?.price;
    if (!raw || price === undefined || price === null) continue;
    if (venueForm && !String(raw).toUpperCase().includes("-SWAP-")) continue;
    const symbol = canonicalSymbol(raw);
    if (allow && !allow.has(symbol)) continue;
    out.push({ symbol, price: String(price) });
  }
  return out;
}

async function defaultGet(url, timeoutMs = 4_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: res.status, headers: res.headers, body };
  } finally { clearTimeout(t); }
}

/** Backoff after a 429: the venue's reset header is authoritative when present, else a
 *  deterministic exponential ladder (2s → 60s) staggered by the caller's jitter. */
export function nextBackoffMs(errors, nowMs, resetAtMs = null, jitterMs = 0) {
  if (Number.isFinite(resetAtMs) && resetAtMs > nowMs) {
    return Math.min(MAX_BACKOFF_MS, resetAtMs - nowMs + 250 + jitterMs);
  }
  return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(errors, 5) + jitterMs);
}

export function resetAtFrom(res) {
  const raw = res?.headers?.get?.(RESET_HEADER) ?? res?.headers?.[RESET_HEADER] ?? null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isRateLimited(res) {
  if (res?.status === 429) return true;
  return TOOBIT_LIMIT_CODES.includes(Number(res?.body?.code));
}

/** Fallback quote freshness (§6.2 S1): REST quotes are CACHED/STALE, never tick parity.
 *  With no fallback quote yet the lag is "stale by definition" — never fresh. */
export function quoteLagMs(state, nowMs) {
  if (Number.isFinite(state?.newest_at_ms) && state.newest_at_ms > 0) {
    return Math.max(0, nowMs - state.newest_at_ms);
  }
  return TH.PRICE_STALE_MS + 1;
}

export function emptyState() {
  return {
    symbols: 0, quotes: [], newest_at_ms: null, last_poll_ms: null, inflight: 0,
    backoff_until_ms: null, errors: 0, rounds: 0, usage_per_min: 0, reason: null,
  };
}

/** In-memory status store (drills + the 5-minute budget loop, where a D1 write per
 *  round would only add latency). */
export function memoryStore(initial = {}) {
  let state = { ...emptyState(), ...initial };
  return {
    read: async () => state,
    write: async (next) => { state = next; },
    peek: () => state,
  };
}

/** The single D1 status row (fixed id, upsert — no migration, no table growth). */
export function d1Store(env, nowIso = () => new Date().toISOString()) {
  return {
    read: async () => {
      const row = await env.DB.prepare(
        "SELECT detail_json FROM health_snapshots WHERE id='" + POLL_ID + "'",
      ).all();
      const last = row.results?.[0];
      if (!last) return emptyState();
      let d = {};
      try { d = JSON.parse(last.detail_json ?? "{}"); } catch { d = {}; }
      return { ...emptyState(), ...d };
    },
    write: async (state) => {
      await env.DB.prepare(
        "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,'fallback_poll',?,?,?) " +
          "ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, at=excluded.at",
      ).bind(POLL_ID, state.inflight ? "POLLING" : "IDLE", JSON.stringify(state), nowIso()).run();
    },
  };
}

function roundState(state, patch) {
  return { ...emptyState(), ...state, ...patch };
}

/** tick — one poll round. Time is an argument, every side effect is injectable, and a
 *  round that would breach the budget is dropped BEFORE any request is sent (§6.2 S1:
 *  the fallback polls "within rate limits" or not at all).
 *
 *  opts: {nowMs, mode, store, window, get, baseUrl, symbols, symbolLimit, jitter,
 *         timeoutMs, actor, env}. Returns {polls, reason, state, ...}. */
export async function tick(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const mode = opts.mode ?? "PRIMARY";
  const store = opts.store ?? d1Store(env);
  const window = opts.window ?? sharedWindow;
  const httpGet = opts.get ?? defaultGet;
  const baseUrl = opts.baseUrl ?? REST_BASE;
  const jitter = opts.jitter ?? (() => Math.floor(Math.random() * 500));
  const actor = opts.actor ?? "fallback-poller";
  const state = await store.read();

  // ADR-004: fallback polling exists because the primary WS/Go plane is down.
  if (mode === "PRIMARY") return { polls: 0, reason: "primary", state };

  // §6.4-style backoff: while the venue told us to wait, we wait.
  if (Number.isFinite(state.backoff_until_ms) && nowMs < state.backoff_until_ms) {
    return { polls: 0, reason: "backoff", next_poll_ms: state.backoff_until_ms, state };
  }
  // ADR-004 cadence floor: never poll faster than POLL_MS.
  if (Number.isFinite(state.last_poll_ms) && nowMs - state.last_poll_ms < POLL_MS) {
    return { polls: 0, reason: "cadence", next_poll_ms: state.last_poll_ms + POLL_MS, state };
  }

  const symbols = opts.symbols ?? (await pollSet(env, { limit: opts.symbolLimit }));
  if (!symbols.length) return { polls: 0, reason: "no-active-watches", state };

  // Weight is 1 per symbol (one filtered request each) — the conservative reading of
  // A-02 / ADR-004, and the shape the live endpoint actually supports.
  const weight = symbols.length * POLL_WEIGHT;
  if (!window.canSpend(nowMs, weight)) {
    return { polls: 0, reason: "budget", weight, usage: window.usage(nowMs), state };
  }

  await store.write(roundState(state, { inflight: 1, reason: "polling", at_ms: nowMs }));

  const quotes = [];
  let sent = 0;
  let usage = window.usage(nowMs);
  let rateLimited = null;
  let failure = null;
  const attempts = 1 + Math.max(0, opts.retries ?? POLL_RETRIES);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (const symbol of symbols) {
    let res = null;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      sent++;
      try {
        res = await httpGet(priceUrl(baseUrl, symbol), opts.timeoutMs);
      } catch (e) {
        res = null;
        lastError = e.message;
      }
      // Every attempt that left the process was counted by the venue, retries included.
      usage = window.spend(nowMs, POLL_WEIGHT);
      if (res) break;
      if (attempt + 1 < attempts) await sleep(opts.retryMs ?? RETRY_MS);
    }
    if (!res) { failure = { reason: "transport-error", error: lastError ?? "unknown" }; break; }
    if (isRateLimited(res)) { rateLimited = res; break; }
    if (res.status !== 200) { failure = { reason: `http-${res.status}`, status: res.status }; break; }
    quotes.push(...parseQuotes(res.body, [symbol], { venueForm: true }));
  }

  if (rateLimited) {
    const errors = (state.errors ?? 0) + 1;
    const resetAt = resetAtFrom(rateLimited);
    const backoff = nextBackoffMs(errors - 1, nowMs, resetAt, jitter());
    const next = roundState(state, {
      inflight: 0, symbols: symbols.length, last_poll_ms: nowMs, reason: "rate-limited",
      backoff_until_ms: nowMs + backoff, errors, usage_per_min: usage, rounds: (state.rounds ?? 0) + 1, at_ms: nowMs,
    });
    await store.write(next);
    // The ADR-004 alert: this must never fire in the 5s/≤100-symbol envelope.
    await recordIncident(env, BACKOFF_INCIDENT, `status=${rateLimited.status} backoff_ms=${backoff} reset=${resetAt ?? "none"} after=${sent}/${symbols.length}`, actor);
    return { polls: sent, status: rateLimited.status, reason: "rate-limited", backoff_until_ms: next.backoff_until_ms, weight, usage, state: next };
  }

  if (failure) {
    const next = roundState(state, {
      inflight: 0, symbols: symbols.length, covered: quotes.length, quotes, last_poll_ms: nowMs,
      reason: failure.reason, errors: (state.errors ?? 0) + 1, usage_per_min: usage,
      rounds: (state.rounds ?? 0) + 1, at_ms: nowMs,
    });
    await store.write(next);
    return { polls: sent, status: failure.status ?? null, reason: failure.reason, error: failure.error, covered: quotes.length, state: next };
  }

  // Every request that was answered covered none of our symbols (e.g. the venue changed
  // shape or dropped the filter): that is NOT fresh data — never mark the snapshot as a
  // quote we do not have.
  if (quotes.length === 0) {
    const next = roundState(state, {
      inflight: 0, symbols: symbols.length, covered: 0, quotes: [], last_poll_ms: nowMs, reason: "no-quotes",
      errors: (state.errors ?? 0) + 1, usage_per_min: usage, rounds: (state.rounds ?? 0) + 1, at_ms: nowMs,
    });
    await store.write(next);
    return { polls: sent, status: 200, reason: "no-quotes", quotes: 0, covered: 0, weight, usage, state: next };
  }

  // Partial coverage (some symbol unanswered) keeps freshness ageing: R-STALE says a
  // partially-supervised watch is stale, never "probably fine" (§6.2 S5 → HELD_STALE).
  const complete = quotes.length === symbols.length;
  const next = roundState(state, {
    symbols: symbols.length, covered: quotes.length, quotes, last_poll_ms: nowMs, inflight: 0,
    newest_at_ms: complete ? nowMs : state.newest_at_ms,
    reason: complete ? "ok" : "partial-quotes",
    backoff_until_ms: null, errors: complete ? 0 : (state.errors ?? 0) + 1,
    usage_per_min: usage, rounds: (state.rounds ?? 0) + 1, at_ms: nowMs,
  });
  await store.write(next);
  return { polls: sent, status: 200, reason: next.reason, quotes: quotes.length, covered: quotes.length, weight, usage, state: next };
}

/** Poller status for the health plane: `drained` feeds §6.3 condition 3 and
 *  `quote_lag_ms` feeds the fallback price freshness of §6.1 / §6.2 S1. */
export async function pollStatus(env, nowMs = Date.now()) {
  const state = await d1Store(env).read();
  return { ...state, drained: !state.inflight, quote_lag_ms: quoteLagMs(state, nowMs) };
}