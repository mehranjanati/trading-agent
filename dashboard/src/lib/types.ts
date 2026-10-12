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