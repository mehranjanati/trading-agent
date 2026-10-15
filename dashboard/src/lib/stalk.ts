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
  chat_session?: string;
  message_id?: string;
  analyze_id?: string;
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
    analyze_id: result.id,
  };
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
  };
}

/** The POST /api/watches body the backend validator expects (validate.mjs:watchBody). */
export function stalkBody(p: SetupProposal): {
  symbol: string;
  direction: "LONG" | "SHORT";
  trigger: { op: string; price: string };
  invalidation: { op: string; price: string };
} {
  const n = normalizeProposal(p);
  return {
    symbol: n.symbol,
    direction: n.direction,
    trigger: { op: n.trigger_op!, price: n.trigger_price },
    invalidation: { op: n.inval_op!, price: n.invalidation_price },
  };
}
