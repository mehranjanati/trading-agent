// stalk.ts — shared setup-proposal shape + parsers for the StalkSetup card.
// Chat (advisory) proposes, dashboard disposes: the model emits one fenced
// ```setup-proposal JSON block, the human clicks Stalk, the dashboard POSTs
// /api/watches (the ONLY write it performs, D-08). No orders, no approvals.
export interface SetupProposal {
  symbol: string;
  direction: "LONG" | "SHORT";
  trigger_price: string;
  invalidation_price: string;
  trigger_op?: string;
  inval_op?: string;
  strategies?: { id: string; version?: string }[];
  timeframes?: string[];
  entry_policy?: { confirm?: Record<string, unknown>; ttl_s?: number };
  // Zone provenance (analyze-derived proposals only): the provider that
  // answered, the bar count and the newest close the ATR zones were measured
  // from. A trigger price without these is a number with no origin — and for a
  // symbol the primary venue does not list, `zone_source` is how the trader
  // sees that the price came from somewhere else.
  zone_source?: string;
  zone_bars?: number;
  zone_last?: string;
  zone_last_ts?: string;
  chat_session?: string;
  message_id?: string;
  analyze_id?: string;
  // When true, the market-regime veto (ETHBTC / USDT.D / BTC.D / TOTAL3) is
  // applied before this watch can reach an order. Absent/false = no regime filter.
  regime_filter?: boolean;
}

const SYM_RE = /^[A-Z]{2,12}USDT$/;
const DEC_RE = /^\d+(\.\d+)?$/;

/** Build a proposal from an /analyze response + its suggested zones. */
export function proposalFromAnalyze(
  result: {
    id: string;
    symbol: string;
    suggest_zones?: {
      trigger_long?: string;
      inval_long?: string;
      trigger_short?: string;
      inval_short?: string;
      source?: string;
      bars?: number;
      last?: string;
      last_ts?: string;
    };
  },
  direction: "LONG" | "SHORT",
): SetupProposal | null {
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
 *  price is real, but it is not the venue the order would be filled on. */
export function isVenueSourced(source?: string): boolean {
  return source === "toobit-rest";
}

/** BandStats — how far the two armed prices sit from the close the zone was
 *  measured on, in % of that close.
 *
 *  WHY THIS IS SHOWN BEFORE THE CLICK: the Go trigger loop evaluates the LIVE
 *  price against exactly these two numbers (docs/05 §5.3a). A band that is only
 *  a fraction of a percent wide is therefore decided by the next tick: the watch
 *  moves ACTIVE→TRIGGERED|INVALIDATED within seconds and disappears from every
 *  ACTIVE-only view — it looks deleted although nothing was ever removed. The
 *  distances make the difference between "stalk a zone" and "fire a zone"
 *  visible while the human can still choose not to click. */
export interface BandStats {
  /** the close the zone was measured on (zone_last), as given by the engine */
  anchor: string;
  /** signed % from the anchor to the trigger (negative = the trigger is below) */
  trigger_pct: number;
  /** signed % from the anchor to the invalidation */
  inval_pct: number;
  /** |inval_pct - trigger_pct| — the whole band, in % of price */
  width_pct: number;
  /** true when the trigger is within IN_PLAY_PCT of the anchor: already live */
  in_play: boolean;
}

/** IN_PLAY_PCT — a trigger closer than this to the zone's own close is not a
 *  level to wait for; the next tick decides the watch. */
export const IN_PLAY_PCT = 0.1;

/** bandStats — null when the proposal carries no usable anchor (a chat proposal
 *  without zone provenance, or a malformed price): nothing is invented. */
export function bandStats(p: SetupProposal | null | undefined): BandStats | null {
  const anchor = Number(p?.zone_last);
  const trig = Number(p?.trigger_price);
  const inval = Number(p?.invalidation_price);
  if (!(anchor > 0) || !(trig > 0) || !(inval > 0)) return null;
  const pct = (x: number) => ((x - anchor) / anchor) * 100;
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

/** fmtPct — a signed percentage at 3 decimals (e.g. "+0.250%"), for the card. */
export function fmtPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
}

/** Extract every fenced ```setup-proposal JSON block from chat text. */
export function extractSetupProposals(text: string): { proposal: SetupProposal | null; raw: string; error?: string }[] {
  const out: { proposal: SetupProposal | null; raw: string; error?: string }[] = [];
  if (typeof text !== "string" || !text.length) return out;
  const re = /```setup-proposal\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const p = JSON.parse(raw) as SetupProposal;
      const err = validateProposal(p);
      out.push(err ? { proposal: null, raw, error: err } : { proposal: normalizeProposal(p), raw });
    } catch (e) {
      out.push({ proposal: null, raw, error: `invalid JSON: ${(e as Error).message}` });
    }
  }
  return out;
}

export function validateProposal(p: SetupProposal): string | null {
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

export function normalizeProposal(p: SetupProposal): SetupProposal {
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

/** The POST /api/watches body the backend validator expects (validate.mjs:watchBody). */
export function stalkBody(p: SetupProposal): {
  symbol: string;
  direction: "LONG" | "SHORT";
  trigger: { op: string; price: string };
  invalidation: { op: string; price: string };
  regime_filter?: boolean;
} {
  const n = normalizeProposal(p);
  const body: {
    symbol: string;
    direction: "LONG" | "SHORT";
    trigger: { op: string; price: string };
    invalidation: { op: string; price: string };
    regime_filter?: boolean;
  } = {
    symbol: n.symbol,
    direction: n.direction,
    trigger: { op: n.trigger_op!, price: n.trigger_price },
    invalidation: { op: n.inval_op!, price: n.invalidation_price },
  };
  if (n.regime_filter === true) body.regime_filter = true;
  return body;
}
