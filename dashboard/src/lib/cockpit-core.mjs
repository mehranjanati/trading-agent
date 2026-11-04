// cockpit-core.mjs — pure logic for the trading cockpit (docs/20, ADR-012).
//
// Everything the cockpit derives is a pure function here, so `node --test`
// exercises the real implementation without a browser (the freshness.mjs /
// setups-core.mjs / library-core.mjs pattern). The Svelte page renders what
// these return and adds no rules of its own.
//
// Two things this file deliberately keeps in one place:
//   1. the LEGACY ROUTE MAP (docs/20 §20.5) — a redirect is a rule, so it is a
//      tested function, not fifteen hand-written `throw redirect` targets that
//      can drift away from the document;
//   2. the per-symbol DERIVATIONS (watch board, approval/intent lines) — the
//      cockpit merges six views, and the merge must not change what any of them
//      meant. `roomWatches` / `deriveStatus` come from setups-core so the
//      sidebar and the room page can never disagree.
import { countdown } from "./freshness.mjs";
import { deriveStatus, roomWatchIds, roomWatches } from "./setups-core.mjs";

export const COCKPIT_PATH = "/cockpit";
export const EXECUTION_PATH = "/execution";
export const ACTIVITY_PATH = "/activity";

/** withParams — path + a deterministic query string built from a map. */
/** @param {string} path @param {Record<string, string>} params @returns {string} */
function withParams(path, params) {
  const usp = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v !== undefined && v !== null && v !== "") usp.set(key, v);
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

/** carry — copy the incoming search params, then set/override the given ones.
 *  A legacy deep link keeps what it carried (e.g. `?symbol=`) and gains the
 *  cockpit parameter, so a redirect never loses information. */
/** @param {string} search @param {Record<string, string>} extra @returns {Record<string, string>} */
function carry(search, extra) {
  /** @type {Record<string, string>} */
  const out = {};
  const usp = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
  usp.forEach((value, key) => {
    out[key] = value;
  });
  return { ...out, ...extra };
}

/** ACTIVITY_TABS — the four timelines the old pages were (docs/20 §20.2). */
export const ACTIVITY_TABS = ["signals", "events", "errors", "failover"];

/** legacyRedirect — the docs/20 §20.5 table as code.
 *
 *  Returns the cockpit/execution/activity URL a legacy path must 302 to, or
 *  `null` when the path is NOT consolidated (the caller then renders normally).
 *  Returning `null` for un-mapped routes is what lets this ship slice-by-slice:
 *  a page is redirected only once its target actually exists.
 *
 *  @param {string} pathname @param {string} [search] @returns {string|null} */
export function legacyRedirect(pathname, search = "") {
  const raw = String(pathname ?? "").trim();
  // Defensive: a caller may hand us `"/x?y=1"` instead of split parts. A legacy
  // link must never fall through un-redirected because of a query string.
  const qIdx = raw.indexOf("?");
  const pathOnly = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const searchAll = qIdx >= 0 ? `?${raw.slice(qIdx + 1)}` : String(search ?? "");
  pathname = pathOnly;
  search = searchAll;
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname || "/";

  if (p === "/" || p === "/setups") return withParams(COCKPIT_PATH, carry(search, {}));

  const room = /^\/setups\/([A-Za-z0-9]{2,24})$/.exec(p);
  if (room) return withParams(COCKPIT_PATH, carry(search, { symbol: room[1].toUpperCase() }));

  if (p === "/watches" || p === "/zones") return withParams(COCKPIT_PATH, carry(search, { tab: "watches" }));
  if (p === "/analyze" || p === "/analysis") return withParams(COCKPIT_PATH, carry(search, { tab: "analysis" }));

  if (p === "/approvals" || p === "/orders") return withParams(EXECUTION_PATH, carry(search, {}));

  if (p === "/signals") return withParams(ACTIVITY_PATH, carry(search, { tab: "signals" }));
  if (p === "/events") return withParams(ACTIVITY_PATH, carry(search, { tab: "events" }));
  if (p === "/logs") return withParams(ACTIVITY_PATH, carry(search, { tab: "errors" }));
  if (p === "/failover") return withParams(ACTIVITY_PATH, carry(search, { tab: "failover" }));

  // /strategies, /strategy and /alerts all folded into /settings (docs/20
  // §20.2): the library/editor, the read-only limit versions and the Telegram
  // topics. Each keeps its own tab so a legacy link lands where it pointed.
  if (p === "/strategies") return withParams("/settings", carry(search, { tab: "groups" }));
  if (p === "/strategy") return withParams("/settings", carry(search, { tab: "limits" }));
  if (p === "/alerts") return withParams("/settings", carry(search, { tab: "alerts" }));

  return null;
}

/** priceOf — the venue's answer for a symbol, or null. A missing key is
 *  "unanswered", never a stale invented number (docs/09 §9.4). */
/** @param {Record<string, string>|null|undefined} prices @param {string} symbol @returns {string|null} */
export function priceOf(prices, symbol) {
  const v = (prices ?? {})[symbol];
  return typeof v === "string" && v ? v : null;
}

/** parseZone — `{op, price}` out of a watch's *_json column, or null.
 *  A malformed or EMPTY value renders as "—" instead of throwing inside the
 *  table (and instead of a row of two question marks): a watch with no zone is
 *  a watch with no zone. */
/** @param {string|undefined|null} json @returns {{ op: string, price: string }|null} */
export function parseZone(json) {
  if (json === undefined || json === null || String(json).trim() === "") return null;
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const hasOp = typeof v.op === "string" && v.op !== "";
    const hasPrice = v.price !== undefined && v.price !== null && String(v.price) !== "";
    if (!hasOp && !hasPrice) return null; // `{}` is not a zone
    return {
      op: hasOp ? v.op : "?",
      price: hasPrice ? String(v.price) : "?",
    };
  } catch {
    return null;
  }
}

/** zoneText — the one-line rendering the board and the zone column share. */
/** @param {string|undefined|null} json @returns {string} */
export function zoneText(json) {
  const z = parseZone(json);
  return z ? `${z.op} ${z.price}` : "—";
}

/** watchBoard — one symbol's watches across the WHOLE lifecycle, ACTIVE first
 *  (ordering and the "never hide a watch" rule come from setups-core, which is
 *  the documented fix for the room that lost a triggered watch). Each row is
 *  display-ready: zones parsed, the regime flag turned into on/off.
 *
 *  The row carries the watch's raw columns (trigger_json / invalidation_json /
 *  regime_filter) which `RoomWatch` deliberately does not declare — it is the
 *  room's minimal projection. This is a projection for display, so it widens
 *  the row rather than asking setups-core to know about columns it never uses.
 *  @param {any[]|null|undefined} watches @param {string} symbol @returns {any[]} */
export function watchBoard(watches, symbol) {
  return roomWatches(watches, symbol).map((raw) => {
    const w = /** @type {any} */ (raw);
    return {
      id: w.id,
      symbol: w.symbol,
      direction: w.direction ?? "—",
      status: w.status,
      version: w.version ?? null,
      regime: w.regime_filter === 1 ? "on" : "off",
      trigger: zoneText(w.trigger_json),
      invalidation: zoneText(w.invalidation_json),
      updated_at: w.updated_at ?? null,
    };
  });
}

/** approvalState — derived exactly like the Worker derives it
 *  (workers/src/approvals.mjs `approvalState`), so the cockpit and `/execution`
 *  agree with the backend about what a single-use token is. Fail closed: an
 *  unreadable expiry is `expired`, never `granted`. */
/** @param {{ decision?: string, used_at?: string|null, expires_at?: string }|null|undefined} row
 *  @param {number} [nowMs]
 *  @returns {"consumed"|"rejected"|"expired"|"granted"|"requested"|null} */
export function approvalState(row, nowMs = Date.now()) {
  if (!row) return null;
  if (row.used_at) return "consumed";
  if (row.decision === "reject") return "rejected";
  const exp = Date.parse(row.expires_at ?? "");
  if (!Number.isFinite(exp)) return "expired";
  if (nowMs >= exp) return "expired";
  if (row.decision === "approve") return "granted";
  return "requested";
}

/** approvalLines — the approval rows for one symbol's watches, with a live
 *  countdown. `expired` rows are kept: they are the audit trail of a token that
 *  lapsed, not noise. */
/** @param {any[]|null|undefined} approvals @param {string[]} watchIds
 *  @param {number} [nowMs] @returns {any[]} */
export function approvalLines(approvals, watchIds, nowMs = Date.now()) {
  const ids = new Set(watchIds ?? []);
  return (approvals ?? [])
    .filter((a) => a && ids.has(a.watch_id))
    .map((a) => ({
      id: a.id,
      watch_id: a.watch_id,
      decision: a.decision,
      state: approvalState(a, nowMs),
      countdown: countdown(a.expires_at, nowMs).text,
      approver: a.approver ?? "—",
    }));
}

/** intentLines — order intents for one symbol's watches. SUBMIT_UNKNOWN is
 *  marked: docs/09 §9.1 says the reconcile state is the story. */
/** @param {any[]|null|undefined} intents @param {string[]} watchIds @returns {any[]} */
export function intentLines(intents, watchIds) {
  const ids = new Set(watchIds ?? []);
  return (intents ?? [])
    .filter((i) => i && ids.has(i.watch_id))
    .map((i) => ({
      id: i.id,
      client_order_id: i.client_order_id,
      status: i.status === "SUBMIT_UNKNOWN" ? "⚠ SUBMIT_UNKNOWN" : i.status,
      side: i.side,
      qty: i.qty,
      leverage: i.leverage,
    }));
}

/** symbolBoard — the sidebar: every venue symbol with its live price, the
 *  room's DERIVED status (same function the room page uses) and whether the
 *  active risk allowlist covers it. Two badges, two different questions:
 *  `status` is what the trader is doing, `tradeable` is what risk would allow
 *  (a venue-only symbol fails R-SYM). */
/** @param {{ symbols?: string[]|null, allowlist?: string[]|null,
 *            prices?: Record<string, string>|null, watches?: any[]|null,
 *            approvals?: any[]|null, positions?: any[]|null }} snap
 *  @returns {any[]} */
export function symbolBoard(snap) {
  const allow = new Set(snap.allowlist ?? []);
  const watches = snap.watches ?? [];
  const positions = snap.positions ?? [];
  const approvals = snap.approvals ?? [];
  return (snap.symbols ?? []).map((symbol) => {
    const watchIds = roomWatchIds(watches, symbol);
    return {
      symbol,
      price: priceOf(snap.prices, symbol),
      status: deriveStatus(symbol, { positions, watches, approvals, watchIds }),
      tradeable: allow.has(symbol),
      active: watches.filter((w) => w?.symbol === symbol && w.status === "ACTIVE").length,
    };
  });
}

/** filterSymbols — sidebar filter. A symbol with a live status (STALKING /
 *  AWAITING-APPROVAL / OPEN) is pinned to the top of the unfiltered list: the
 *  desk should open on what is already in play, not on the alphabet. */
/** @param {any[]|null|undefined} rows @param {string} [filter] @param {number} [limit]
 *  @returns {any[]} */
export function filterSymbols(rows, filter = "", limit = 300) {
  const q = String(filter ?? "").trim().toUpperCase();
  const list = (rows ?? []).filter((r) => r && (!q || String(r.symbol).includes(q)));
  if (q) return list.slice(0, limit);
  const busy = list.filter((r) => r.status !== "IDLE");
  const idle = list.filter((r) => r.status === "IDLE");
  return [...busy, ...idle].slice(0, limit);
}

/** aggregateSummary — the cockpit's one-line verdict from an /analyze response.
 *  Confidence stays a VOTE SHARE (SAFE-009): it is rendered as "agree 2/3",
 *  never as a win probability. */
/** @param {any} result @returns {any|null} */
export function aggregateSummary(result) {
  const a = result?.aggregate;
  if (!a) return null;
  return {
    bias: a.bias ?? "FLAT",
    confidence: typeof a.confidence === "number" ? a.confidence : null,
    agree: a.agree ?? 0,
    disagree: a.disagree ?? 0,
    flat: a.flat ?? 0,
    errors: a.errors ?? 0,
    n: a.n ?? 0,
    explanation: a.explanation ?? "",
  };
}

/** ERROR_RE / FAILOVER_RE — the two incident filters the old `/logs` and
 *  `/failover` pages applied, kept here so `/activity` shows the same rows. */
export const ERROR_RE = /error|fenced|unknown|backoff|down/i;
export const FAILOVER_RE = /drill|reconcile\.complete|kill\.|lease\.|health\.recovered|rate_limit_backoff|exit/i;

/** incidentRows — one tab's rows off the recovery log. `tab` is one of
 *  ACTIVITY_TABS; an unknown tab falls back to `events` (never an empty view
 *  that looks like "no incidents"). */
/** @param {any[]|null|undefined} incidents @param {string} [tab] @returns {any[]} */
export function incidentRows(incidents, tab = "events") {
  const all = (incidents ?? []).filter(Boolean);
  if (tab === "errors") {
    return all.filter((i) => ERROR_RE.test(`${i.incident ?? ""} ${i.action ?? ""}`));
  }
  if (tab === "failover") {
    return all.filter((i) => FAILOVER_RE.test(`${i.incident ?? ""} ${i.action ?? ""}`));
  }
  return all;
}

/** signalRows — the signals tab. A signal with no watch is legal (an ingest
 *  that arrived before any stalk), so `watch` renders "—". */
/** @param {any[]|null|undefined} signals @returns {any[]} */
export function signalRows(signals) {
  return (signals ?? []).filter(Boolean).map((s) => ({
    id: s.id,
    watch_id: s.watch_id ?? "—",
    kind: s.kind,
    source: s.source,
    at: s.at,
  }));
}
