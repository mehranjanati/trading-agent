// stalk-core.mjs — the pure setup-proposal logic for the StalkSetup card: no
// Svelte, no DOM, no fetch, so `node --test` imports the REAL implementation
// instead of a hand-copied mirror (the freshness.mjs / setups-core.mjs /
// groups-core.mjs / library-core.mjs pattern).
//
// WHY A .mjs CORE: this logic used to live in stalk.ts and the test imported
// the .ts file directly. CI pins Node 20 (`node-version: "20"`), which cannot
// load a .ts specifier at all — `make check` and the dashboard job both died
// with ERR_UNKNOWN_FILE_EXTENSION before a single assertion ran, so the E11
// `suites_green` gate check could never be satisfied. Types stay in stalk.ts
// (the typed surface the Svelte components import); the behaviour lives here,
// in a module any supported Node can execute.
//
// Chat (advisory) proposes, dashboard disposes: the model emits one fenced
// ```setup-proposal JSON block, the human clicks Stalk, the dashboard POSTs
// /api/watches (the ONLY write it performs, D-08). No orders, no approvals.

/**
 * @typedef {object} SetupProposal
 * @property {string} symbol
 * @property {"LONG"|"SHORT"} direction
 * @property {string} trigger_price
 * @property {string} invalidation_price
 * @property {string} [trigger_op]
 * @property {string} [inval_op]
 * @property {{ id: string, version?: string }[]} [strategies]
 * @property {string[]} [timeframes]
 * @property {{ confirm?: Record<string, unknown>, ttl_s?: number }} [entry_policy]
 * @property {string} [zone_source] the provider that answered (toobit-rest vs a fallback)
 * @property {number} [zone_bars] the bar count the ATR zones were measured from
 * @property {string} [zone_last] the newest close the zones were measured on
 * @property {string} [zone_last_ts]
 * @property {string} [chat_session]
 * @property {string} [message_id]
 * @property {string} [analyze_id]
 * @property {boolean} [regime_filter] apply the market-regime veto before any order
 */

/**
 * @typedef {object} SuggestedZones
 * @property {string} [trigger_long]
 * @property {string} [inval_long]
 * @property {string} [trigger_short]
 * @property {string} [inval_short]
 * @property {string} [source]
 * @property {number} [bars]
 * @property {string} [last]
 * @property {string} [last_ts]
 */

/**
 * @typedef {object} AnalyzeResult
 * @property {string} id
 * @property {string} symbol
 * @property {SuggestedZones} [suggest_zones]
 */

/**
 * @typedef {object} BandStats
 * @property {string} anchor the close the zone was measured on (zone_last)
 * @property {number} trigger_pct signed % from the anchor to the trigger
 * @property {number} inval_pct signed % from the anchor to the invalidation
 * @property {number} width_pct |inval_pct - trigger_pct| — the whole band, in %
 * @property {boolean} in_play true when the trigger is within IN_PLAY_PCT
 */

/**
 * @typedef {object} StalkBody
 * @property {string} symbol
 * @property {"LONG"|"SHORT"} direction
 * @property {{ op: string, price: string }} trigger
 * @property {{ op: string, price: string }} invalidation
 * @property {boolean} [regime_filter]
 */

/**
 * @typedef {object} ProposalParse
 * @property {SetupProposal|null} proposal
 * @property {string} raw
 * @property {string} [error]
 */

const SYM_RE = /^[A-Z]{2,12}USDT$/;
const DEC_RE = /^\d+(\.\d+)?$/;

/** Build a proposal from an /analyze response + its suggested zones.
 *  @param {AnalyzeResult} result
 *  @param {"LONG"|"SHORT"} direction
 *  @returns {SetupProposal|null} */
export function proposalFromAnalyze(result, direction) {
  const z = result?.suggest_zones;
  if (!result?.symbol || !z) return null;
  if (!SYM_RE.test(result.symbol)) return null;
  const long = direction !== "SHORT";
  const trigger_price = long ? z.trigger_long : z.trigger_short;
  const invalidation_price = long ? z.inval_long : z.inval_short;
  if (typeof trigger_price !== "string" || !DEC_RE.test(trigger_price)) return null;
  if (typeof invalidation_price !== "string" || !DEC_RE.test(invalidation_price)) return null;
  return {
    symbol: result.symbol,
    direction,
    trigger_price,
    invalidation_price,
    trigger_op: long ? ">=" : "<=",
    inval_op: long ? "<=" : ">=",
    // Provenance travels with the prices: the card must be able to say which
    // provider the zone was measured on and how fresh its newest bar was.
    zone_source: typeof z.source === "string" ? z.source : undefined,
    zone_bars: typeof z.bars === "number" ? z.bars : undefined,
    zone_last: typeof z.last === "string" ? z.last : undefined,
    zone_last_ts: typeof z.last_ts === "string" ? z.last_ts : undefined,
    analyze_id: result.id,
  };
}

/** isVenueSourced — true when the zone's provider is the trading venue itself
 *  (Toobit). Anything else (okx-rest/binance-rest) is a fallback provider: the
 *  price is real, but it is not the venue the order would be filled on.
 *  @param {string} [source]
 *  @returns {boolean} */
export function isVenueSourced(source) {
  return source === "toobit-rest";
}

/** IN_PLAY_PCT — a trigger closer than this to the zone's own close is not a
 *  level to wait for; the next tick decides the watch. */
export const IN_PLAY_PCT = 0.1;

/** bandStats — how far the two armed prices sit from the close the zone was
 *  measured on, in % of that close.
 *
 *  WHY THIS IS SHOWN BEFORE THE CLICK: the Go trigger loop evaluates the LIVE
 *  price against exactly these two numbers (docs/05 §5.3a). A band that is only
 *  a fraction of a percent wide is therefore decided by the next tick: the watch
 *  moves ACTIVE→TRIGGERED|INVALIDATED within seconds and disappears from every
 *  ACTIVE-only view — it looks deleted although nothing was ever removed. The
 *  distances make the difference between "stalk a zone" and "fire a zone"
 *  visible while the human can still choose not to click.
 *
 *  Null when the proposal carries no usable anchor (a chat proposal without
 *  zone provenance, or a malformed price): nothing is invented.
 *  @param {SetupProposal|null|undefined} p
 *  @returns {BandStats|null} */
export function bandStats(p) {
  const anchor = Number(p?.zone_last);
  const trig = Number(p?.trigger_price);
  const inval = Number(p?.invalidation_price);
  if (!(anchor > 0) || !(trig > 0) || !(inval > 0)) return null;
  /** @param {number} x */
  const pct = (x) => ((x - anchor) / anchor) * 100;
  const trigger_pct = pct(trig);
  const inval_pct = pct(inval);
  return {
    anchor: String(p?.zone_last),
    trigger_pct,
    inval_pct,
    width_pct: Math.abs(inval_pct - trigger_pct),
    in_play: Math.abs(trigger_pct) <= IN_PLAY_PCT,
  };
}

/** fmtPct — a signed percentage at 3 decimals (e.g. "+0.250%"), for the card.
 *  @param {number} x
 *  @returns {string} */
export function fmtPct(x) {
  return `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
}

/** Extract every fenced ```setup-proposal JSON block from chat text.
 *  @param {string} text
 *  @returns {ProposalParse[]} */
export function extractSetupProposals(text) {
  /** @type {ProposalParse[]} */
  const out = [];
  if (typeof text !== "string" || !text.length) return out;
  const re = /```setup-proposal\s*\n([\s\S]*?)```/g;
  /** @type {RegExpExecArray|null} */
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const p = /** @type {SetupProposal} */ (JSON.parse(raw));
      const err = validateProposal(p);
      out.push(err ? { proposal: null, raw, error: err } : { proposal: normalizeProposal(p), raw });
    } catch (e) {
      out.push({ proposal: null, raw, error: `invalid JSON: ${/** @type {Error} */ (e).message}` });
    }
  }
  return out;
}

/** validateProposal — the shape the watch API can actually arm, or why not.
 *  Takes untrusted JSON, so it is typed loosely on purpose.
 *  @param {any} p
 *  @returns {string|null} */
export function validateProposal(p) {
  if (!p || typeof p !== "object") return "proposal must be an object";
  if (!SYM_RE.test(p.symbol ?? "")) return "symbol must match ^[A-Z]{2,12}USDT$";
  if (p.direction !== "LONG" && p.direction !== "SHORT") return "direction must be LONG|SHORT";
  if (typeof p.trigger_price !== "string" || !DEC_RE.test(p.trigger_price)) return "trigger_price must be decimal string";
  if (typeof p.invalidation_price !== "string" || !DEC_RE.test(p.invalidation_price)) return "invalidation_price must be decimal string";
  const ops = [">=", "<=", "cross_above", "cross_below"];
  if (p.trigger_op !== undefined && !ops.includes(p.trigger_op)) return "trigger_op unknown";
  if (p.inval_op !== undefined && !ops.includes(p.inval_op)) return "inval_op unknown";
  return null;
}

/** normalizeProposal — default the operators from the direction and drop
 *  unknown keys.
 *  @param {SetupProposal} p
 *  @returns {SetupProposal} */
export function normalizeProposal(p) {
  const long = p.direction !== "SHORT";
  return {
    symbol: p.symbol,
    direction: p.direction,
    trigger_price: p.trigger_price,
    invalidation_price: p.invalidation_price,
    trigger_op: p.trigger_op ?? (long ? ">=" : "<="),
    inval_op: p.inval_op ?? (long ? "<=" : ">="),
    strategies: Array.isArray(p.strategies) ? p.strategies : undefined,
    timeframes: Array.isArray(p.timeframes) ? p.timeframes : undefined,
    entry_policy: p.entry_policy,
    chat_session: p.chat_session,
    message_id: p.message_id,
    analyze_id: p.analyze_id,
    regime_filter: p.regime_filter === true,
  };
}

/** The POST /api/watches body the backend validator expects (validate.mjs:watchBody).
 *  @param {SetupProposal} p
 *  @returns {StalkBody} */
export function stalkBody(p) {
  const n = normalizeProposal(p);
  /** @type {StalkBody} */
  const body = {
    symbol: n.symbol,
    direction: n.direction,
    trigger: { op: n.trigger_op ?? ">=", price: n.trigger_price },
    invalidation: { op: n.inval_op ?? "<=", price: n.invalidation_price },
  };
  if (n.regime_filter === true) body.regime_filter = true;
  return body;
}
