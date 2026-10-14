// api.ts — E10-T01: the BFF client. READ-ONLY by design (docs/02 §2.2): every
// call is a GET against the Workers API; there is deliberately no helper that
// POSTs an order or an approval — the dashboard never submits (D-08). Every
// response carries `at`, so each widget can derive its own freshness badge.
//
// E14-T01: /analyze is an exception — it POSTs to the Go watcher (advisory
// only, never orders/approvals). D-08 is preserved: the dashboard still never
// submits orders.
import type { Health, Watch, Signal, AnalysisRun, Approval, OrderIntent, Position, RecoveryIncident, StrategyVersion, BadgeLabel, StrategyDraft, AnalyzeRequest, AnalyzeResponse } from "./types";
import { badge, modeBanner, actionBlocker } from "./freshness.mjs";

export const API_BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined) ?? "http://127.0.0.1:8787";
// Go watcher :8080 — advisory analysis only (no orders, no approvals).
export const ANALYZE_BASE: string = (import.meta.env?.VITE_ANALYZE_BASE as string | undefined) ?? "http://127.0.0.1:8080";
// Chat sessions (Redis) + WebSocket streaming live inside the Go watcher
// (:8080) — one binary, one port. Advisory only: no orders, no approvals.
export const CHAT_BASE: string = (import.meta.env?.VITE_CHAT_BASE as string | undefined) ?? ANALYZE_BASE;
/** ws:// host for the chat turn loop; https pages must set VITE_CHAT_WS_BASE to a wss:// tunnel. */
export const CHAT_WS_BASE: string =
  (import.meta.env?.VITE_CHAT_WS_BASE as string | undefined) ??
  CHAT_BASE.replace(/^http/, "ws");

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

/** POST to the Go watcher /analyze (advisory only, D-08 preserved). */
export async function postAnalyze(body: AnalyzeRequest): Promise<Result<AnalyzeResponse>> {
  try {
    const res = await fetch(`${ANALYZE_BASE}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: data.at ?? new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** POST /api/watches — the ONLY write the dashboard performs (D-08: orders
 *  and approvals are never submitted from the dashboard). */
export async function postWatch(body: { symbol: string; direction: "LONG" | "SHORT"; trigger_json: string; invalidation_json: string }): Promise<Result<{ id: string }>> {
  try {
    const res = await fetch(`${API_BASE}/api/watches`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** POST /api/strategy:generate — chat → Go draft (advisory only, D-08). */
export async function postGenerateStrategy(body: {
  description: string;
  strategy_id: string;
  version: string;
}): Promise<Result<{ id: string; strategy_id: string; version: string; code: string; model: string; status: string }>> {
  try {
    const res = await fetch(`${API_BASE}/api/strategy:generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** GET /api/strategy:drafts — list AI-generated strategy drafts. */
export async function getStrategyDrafts(): Promise<Result<{ drafts: StrategyDraft[] }>> {
  try {
    const res = await fetch(`${API_BASE}/api/strategy:drafts`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** POST /api/strategy:chat — multi-turn chat with AI. */
export async function postChat(body: {
  messages: { role: string; content: string }[];
  principles?: string;
}): Promise<Result<{ response: string; codeBlocks: { language: string; code: string }[]; model: string }>> {
  try {
    const res = await fetch(`${API_BASE}/api/strategy:chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** POST /api/strategy:draft — save extracted code as draft (no AI call). */
export async function postDraft(body: {
  strategy_id: string;
  version: string;
  code: string;
  prompt?: string;
}): Promise<Result<{ id: string; status: string }>> {
  try {
    const res = await fetch(`${API_BASE}/api/strategy:draft`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Chat service (inside go-watcher :8080) ─ Redis sessions, WS streaming ────
// Advisory plane only: create/read/delete sessions and save principles.
// The real-time turn loop runs over chatSocket(). If the Go chat routes are
// unreachable (e.g. public Pages without a tunnel), the /chat page falls back
// to the Worker REST endpoint postChat above.

export type ChatStoredMessage = { role: string; content: string; timestamp: string };

/** Availability probe: any HTTP reply from the chat routes means the service is up. */
export async function chatServiceUp(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${CHAT_BASE}/api/chat/_probe`, { signal: ac.signal, headers: { accept: "application/json" } });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

/** POST /api/chat/create — start a Redis-backed session. */
export async function postChatCreate(principles = ""): Promise<Result<{ id: string }>> {
  try {
    const res = await fetch(`${CHAT_BASE}/api/chat/create`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ principles }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** GET /api/chat/{id} — reload persisted history. */
export async function getChatSession(id: string): Promise<Result<{ messages: ChatStoredMessage[]; principles: string }>> {
  try {
    const res = await fetch(`${CHAT_BASE}/api/chat/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** DELETE /api/chat/{id} — drop the session (Clear chat). */
export async function deleteChatSession(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${CHAT_BASE}/api/chat/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

/** POST /api/chat/{id}/principles — persist principles with the session. */
export async function postChatPrinciples(id: string, content: string): Promise<boolean> {
  try {
    const res = await fetch(`${CHAT_BASE}/api/chat/${encodeURIComponent(id)}/principles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Open the real-time turn socket for a session. */
export function chatSocket(id: string): WebSocket {
  return new WebSocket(`${CHAT_WS_BASE}/ws/chat/${encodeURIComponent(id)}`);
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