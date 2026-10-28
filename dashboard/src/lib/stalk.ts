// stalk.ts — the TYPED surface of the setup-proposal logic for the StalkSetup
// card. The behaviour lives in stalk-core.mjs so `node --test` imports the real
// implementation on every Node the repo supports (CI pins Node 20, which cannot
// load a .ts specifier — importing `./stalk.ts` from a test killed both CI jobs
// with ERR_UNKNOWN_FILE_EXTENSION). Same split as setups.ts/setups-core.mjs and
// groups.ts/groups-core.mjs.
//
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

export {
  proposalFromAnalyze,
  isVenueSourced,
  bandStats,
  fmtPct,
  extractSetupProposals,
  validateProposal,
  normalizeProposal,
  stalkBody,
  IN_PLAY_PCT,
} from "./stalk-core.mjs";
