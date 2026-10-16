// types.ts — E10-T01: the shapes the dashboard reads from the Workers BFF.
// READ-ONLY by design (docs/02 §2.2): the dashboard never submits an order.
export type Mode = "PRIMARY" | "DEGRADED" | "FALLBACK" | "HALTED" | "D1_DOWN";
export type BadgeLabel = "LIVE" | "STALE" | "CACHED" | "UNAVAILABLE";

export interface Health {
  mode: Mode;
  badge: string;
  reasons: string[];
  components: { component: string; status: string; detail: Record<string, unknown> }[];
  at: string | null;
}
export interface Watch {
  id: string; symbol: string; direction: "LONG" | "SHORT";
  trigger_json: string; invalidation_json: string; status: string;
  version: number; expires_at: string | null; updated_at: string;
}
export interface Signal {
  id: string; watch_id: string | null; kind: string;
  payload_json: string; source: string; at: string;
}
export interface AnalysisRun {
  id: string; watch_id: string; model: string; input_hash: string;
  output_json: string; confidence: number | null; at: string;
}
export interface Approval {
  id: string; watch_id: string; analysis_id: string; decision: string;
  reason: string | null; approver: string; used_at: string | null;
  expires_at: string; at: string;
}
export interface OrderIntent {
  id: string; watch_id: string; approval_id: string; side: string;
  qty: string; leverage: number; client_order_id: string; status: string; at: string;
}
export interface Position {
  symbol: string; size: string; entry_px: string | null;
  leverage: number | null; updated_at: string;
}
export interface RecoveryIncident {
  id: string; incident: string; action: string; actor: string; at: string;
}
export interface StrategyVersion {
  version: string; config_json: string; activated_by: string; at: string;
}

export interface StrategyDraft {
  id: string;
  strategy_id: string;
  version: string;
  prompt: string;
  code: string;
  model: string;
  status: string;
  created_by: string;
  created_at: string;
}

// E14-T01: deep-analysis types (advisory only, D-08 preserved).
export interface AnalyzeRequest {
  symbol: string;
  direction?: "LONG" | "SHORT";
  timeframes?: string[];
  strategies: { id: string; version?: string; config?: Record<string, unknown> }[];
  position?: { entry: string; size: string; leverage: number };
}

export interface AnalyzeResponse {
  id: string;
  symbol: string;
  at: string;
  aggregate: {
    bias: "LONG" | "SHORT" | "FLAT";
    confidence: number;
    agree: number;
    disagree: number;
    flat: number;
    errors: number;
    n: number;
    explanation: string;
  };
  verdicts: {
    strategy_id: string;
    strategy_version: string;
    strategy_sha256: string;
    timeframe: string;
    invocation_id: string;
    input_hash: string;
    result: {
      contract_version: string;
      strategy_id: string;
      strategy_version: string;
      invocation_id: string;
      status: "SIGNAL" | "NO_SIGNAL" | "ERROR";
      decision: { bias: "LONG" | "SHORT" | "FLAT"; confidence: number };
      signals: { kind: string; symbol: string }[];
      proposed_state: Record<string, unknown>;
      diagnostics: { reason: string; code: string; logs: string[] };
    };
    data_source: string;
  }[];
  suggest_zones: {
    timeframe: string;
    /** Provider that answered for this timeframe: toobit-rest | okx-rest | binance-rest.
     *  Only toobit-rest is the trading venue; the others are failover providers. */
    source?: string;
    bars?: number;
    last?: string;
    last_ts?: string;
    atr: string;
    trigger_long: string;
    inval_long: string;
    trigger_short: string;
    inval_short: string;
  };
}