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

// Production Worker — the fallback when no VITE_* env is baked in (Pages
// deploys must set VITE_API_BASE at build time; this default keeps a stale
// or env-less bundle from ever pointing at localhost in production).
// 2026-10-14: production moved to the fa101008 account after Apjkala25 lost
// R2 at the account level — the old apjkala25 URL is no longer the live API.
const PROD_WORKER = "https://trading-agent-control.mehranjannati.workers.dev";

export const API_BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined) ?? PROD_WORKER;
// Go watcher :8080 — advisory analysis only (no orders, no approvals).
// In production the Worker proxies advisory routes, so the Worker URL is the
// safe fallback (never localhost — a Pages browser has no local server).
export const ANALYZE_BASE: string = (import.meta.env?.VITE_ANALYZE_BASE as string | undefined) ?? PROD_WORKER;
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
 *  and approvals are never submitted from the dashboard). Body shape matches
 *  the backend validator (workers/src/validate.mjs:watchBody): trigger and
 *  invalidation are OBJECTS {op, price}, never pre-stringified JSON. */
export async function postWatch(body: { symbol: string; direction: "LONG" | "SHORT"; trigger: { op: string; price: string }; invalidation?: { op: string; price: string } }): Promise<Result<{ id: string }>> {
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

/** POST /api/strategy:draft:delete — discard one AI draft (advisory-only data:
 *  nothing builds or executes from a draft). The Worker SOFT-deletes it
 *  (status='deleted') so the row stays auditable and leaves the drafts list —
 *  `kept_for_audit` in the response says so, the UI reports it. */
export async function deleteStrategyDraft(id: string): Promise<Result<{ id: string; status: string; kept_for_audit?: boolean }>> {
  try {
    const res = await fetch(`${API_BASE}/api/strategy:draft:delete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader", accept: "application/json" },
      body: JSON.stringify({ id }),
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

/** One multimodal content part (OpenAI/Qwen shape) — a chart rides the `user`
 *  turn as an image_url part; the deprecated top-level `image` param is unused. */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

/** A turn as sent to the Worker (content is a string, or parts when charted). */
export type ChatOutboundMessage = { id?: string; role: string; content: string | ChatContentPart[] };

/** POST /api/strategy:chat — multi-turn chat with AI (advisory only). */
export async function postChat(body: {
  session_id?: string;
  messages: ChatOutboundMessage[];
  principles?: string;
  /** The dashboard's ROOM/SETUP block for this turn (setup rooms live in this
   *  browser's localStorage). The Worker injects it as a labelled DATA system
   *  turn — the same block the Go chat service injects over WebSocket. */
  context?: string;
}): Promise<Result<{ response: string; codeBlocks: { language: string; code: string }[]; model: string; vision?: boolean }>> {
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

/** POST /api/strategy:draft — save extracted code as draft (no AI call).
 *  message_id links the draft to the chart turn that produced it (ADR-010). */
export async function postDraft(body: {
  strategy_id: string;
  version: string;
  code: string;
  prompt?: string;
  message_id?: string;
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

// ── Strategy catalog (the pinned WASM registry) ──────────────────────────────
// One row of GET /strategies/registry (Go plane; the Worker proxies it).
export type RegistryRow = {
  id: string;
  version: string;
  name?: string;
  description?: string;
  sha256?: string;
  configuration?: Record<string, unknown>;
};

/** The pinned strategy catalog, straight from the Go plane — the bytes the
 *  runner will execute. Returns ok:false when unreachable: the CALLER must then
 *  label the offline mirror instead of rendering a stale list as live
 *  (library-core.composeCatalog reports which path it took). */
export async function getRegistry(): Promise<Result<{ strategies: RegistryRow[]; count?: number; at?: string }>> {
  try {
    const res = await fetch(`${ANALYZE_BASE}/strategies/registry`, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    const at: string = body?.at ?? new Date().toISOString();
    return { ok: true, data: body, at, ageMs: Date.now() - Date.parse(at) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Chat service (inside go-watcher :8080) ─ Redis sessions, WS streaming ────
// Advisory plane only: create/read/delete sessions and save principles.
// The real-time turn loop runs over chatSocket(). If the Go chat routes are
// unreachable (e.g. public Pages without a tunnel), the /chat page falls back
// to the Worker REST endpoint postChat above.

export type ChatStoredAttachment = { mediaType: string; dataUrl?: string; detail?: string; bytes?: number };
export type ChatStoredMessage = { id?: string; role: string; content: string; attachments?: ChatStoredAttachment[]; timestamp: string };

/** Availability probe: any HTTP reply from the chat routes means the service is up.
 *  NOTE: /api/chat/* lives in the Go watcher only — the Worker answers 501
 *  (NOT_IMPLEMENTED), which correctly means "REST fallback mode". The 501 is
 *  expected on Pages, so this probe never logs it (console noise, not an error). */
export async function chatServiceUp(): Promise<boolean> {
  // On a Pages deployment CHAT_BASE is the Worker, which has no /api/chat/*
  // routes (they live in go-watcher). Skip the probe entirely and go straight
  // to the Worker REST endpoint — no failed request, no console noise.
  if (CHAT_BASE.includes("workers.dev")) return false;
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

// ── Chart attachments (ADR-010) ──────────────────────────────────────────────
// The client downscales BEFORE upload. Measured live: a 1600x900 chart costs
// ~1432 prompt tokens at detail:"low" and the cost scales with resolution, so a
// 4K screenshot would burn ~4x that for no extra insight. Longest edge 1568px
// is the vision tower's sweet spot; screenshots re-encode as JPEG q0.85.

/** MAX_IMAGE_EDGE is the longest-edge cap applied before upload. */
export const MAX_IMAGE_EDGE = 1568;

/** One downscaled chart ready for a turn (data URL + decoded size). */
export type ChartAttachment = { mediaType: string; dataUrl: string; bytes: number };

/** downscaleImage re-encodes a pasted/dropped image for a chat turn. Returns
 *  null when the browser cannot decode it (the caller shows an error). */
export async function downscaleImage(
  file: Blob,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<ChartAttachment | null> {
  const maxEdge = opts.maxEdge ?? MAX_IMAGE_EDGE;
  const quality = opts.quality ?? 0.85;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // JPEG has no alpha: a transparent PNG would otherwise come out black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const mediaType = "image/jpeg";
    const dataUrl = canvas.toDataURL(mediaType, quality);
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return { mediaType, dataUrl, bytes: Math.floor((b64.length * 3) / 4) };
  } catch {
    return null;
  }
}

export const getHealth = () => getJson<Health>("/api/health");
export const getWatches = () => getJson<{ watches: Watch[] }>("/api/watches?status=ACTIVE");
/** EVERY watch, newest first (no status filter — the Worker's list route with no
 *  `status` param). The setup room must read the full lifecycle: a watch that
 *  moved ACTIVE→TRIGGERED|INVALIDATED is exactly the one whose analysis,
 *  approvals and orders have to stay visible, and the ACTIVE-only feed makes it
 *  look deleted (docs/05 §5.3 — the FSM never deletes a watch, it transitions
 *  it). /watches itself stays ACTIVE-only by design (docs/09 §9.1). */
export const getWatchesAll = () => getJson<{ watches: Watch[] }>("/api/watches");
export const getSignals = () => getJson<{ signals: Signal[] }>("/api/signals");
export const getAnalysis = () => getJson<{ runs: AnalysisRun[] }>("/api/analysis");
export const getApprovals = () => getJson<{ approvals: Approval[] }>("/api/approvals");
export const getIntents = () => getJson<{ intents: OrderIntent[] }>("/api/orders:intents");
export const getPositions = () => getJson<{ positions: Position[] }>("/api/positions");
export const getRecoveryLog = (limit = 50) => getJson<{ incidents: RecoveryIncident[] }>(`/api/recovery/log?limit=${limit}`);
export const getStrategies = () => getJson<{ versions: StrategyVersion[] }>("/api/strategy");

/** Telegram alert topics (docs/09 §9.3a): absent = enabled. Advisory only. */
export type NotifyPrefs = { prefs: { topic: string; enabled: boolean }[] };
export const getNotifyPrefs = () => getJson<NotifyPrefs>("/api/notify:prefs");
/** Toggle topics via POST (trader+, in the browser POST allow-list — advisory,
 *  no order/approval path is reachable from it, D-08 preserved). */
export async function setNotifyPrefs(prefs: Record<string, boolean>): Promise<Result<{ updated: { topic: string; enabled: boolean }[] }>> {
  try {
    const res = await fetch(`${API_BASE}/api/notify:prefs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader", accept: "application/json" },
      body: JSON.stringify({ prefs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { message?: string })?.message ?? `HTTP ${res.status}` };
    return { ok: true, data: data as { updated: { topic: string; enabled: boolean }[] }, at: new Date().toISOString(), ageMs: 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Convenience wrappers over the pure freshness module, pre-filled from a Result.
 *  A null/undefined result (before the first load, or a crashed load) is
 *  UNAVAILABLE — never "fresh", and never a crash. */
export function badgeFor(result?: Result<unknown> | null): { label: BadgeLabel; tone: string; age_s: number | null } {
  if (!result) return badge({ source: "unavailable" });
  if (!result.ok) return badge({ source: "unavailable" });
  return badge({ ageMs: result.ageMs });
}
export { modeBanner, actionBlocker };