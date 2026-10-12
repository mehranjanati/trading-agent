// api.ts — E10-T01: the BFF client. READ-ONLY by design (docs/02 §2.2): every
// call is a GET against the Workers API; there is deliberately no helper that
// POSTs an order or an approval — the dashboard never submits (D-08). Every
// response carries `at`, so each widget can derive its own freshness badge.
import type { Health, Watch, Signal, AnalysisRun, Approval, OrderIntent, Position, RecoveryIncident, StrategyVersion, BadgeLabel } from "./types";
import { badge, modeBanner, actionBlocker } from "./freshness.mjs";

export const API_BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined) ?? "http://127.0.0.1:8787";

export type Result<T> = { ok: true; data: T; at: string; ageMs: number } | { ok: false; error: string };

/** One fetch, one shape: {ok, data, at, ageMs} — never throws. */
export async function getJson<T>(path: string): Promise<Result<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    const at: string = body?.at ?? new Date().toISOString();
    return { ok: true, data: body as T, at, ageMs: Date.now() - Date.parse(at) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const getHealth = () => getJson<Health>("/api/health");
export const getWatches = () => getJson<{ watches: Watch[] }>("/api/watches?status=ACTIVE");
export const getSignals = () => getJson<{ signals: Signal[] }>("/api/signals");
export const getAnalysis = () => getJson<{ runs: AnalysisRun[] }>("/api/analysis");
export const getApprovals = () => getJson<{ approvals: Approval[] }>("/api/approvals");
export const getIntents = () => getJson<{ intents: OrderIntent[] }>("/api/orders:intents");
export const getPositions = () => getJson<{ positions: Position[] }>("/api/positions");
export const getRecoveryLog = (limit = 50) => getJson<{ incidents: RecoveryIncident[] }>(`/api/recovery/log?limit=${limit}`);
export const getStrategies = () => getJson<{ versions: StrategyVersion[] }>("/api/strategy");

/** Convenience wrappers over the pure freshness module, pre-filled from a Result.
 *  A null/undefined result (before the first load, or a crashed load) is
 *  UNAVAILABLE — never "fresh", and never a crash. */
export function badgeFor(result?: Result<unknown> | null): { label: BadgeLabel; tone: string; age_s: number | null } {
  if (!result) return badge({ source: "unavailable" });
  if (!result.ok) return badge({ source: "unavailable" });
  return badge({ ageMs: result.ageMs });
}
export { modeBanner, actionBlocker };