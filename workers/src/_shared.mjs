// _shared.mjs — E05-T01-S3: uid, roles, RBAC guard, body/error helpers.
// PROD NOTE: roleOf reads X-Role for tests/local. OIDC middleware (E05-T02 phase)
// must replace this before any staging deploy — flagged TODO in index.ts.
import { err } from "./errors.mjs";

export function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
export function roleOf(req) {
  return req.headers.get("x-role") ?? "trader";
}
// RBAC per docs/ops/RBAC-MATRIX.md.
export const ALLOW = {
  "POST /api/watches": ["trader", "operator", "admin"],
  "POST /api/signals:ingest": ["trader", "operator", "admin"],
  "POST /api/analysis:runs": ["trader", "operator", "admin"],
  "POST /api/approvals": ["trader", "admin"],
  "POST /api/strategy:activate": ["admin"],
  // AI strategy generation: trader+ may ASK the model for Go code. The draft
  // is review-only (strategy_drafts); nothing builds or executes from here.
  "POST /api/strategy:generate": ["trader", "operator", "admin"],
  // Multi-turn chat: same RBAC as generate (advisory only, no orders).
  "POST /api/strategy:chat": ["trader", "operator", "admin"],
  // Streaming variant of chat (SSE passthrough): same RBAC.
  "POST /api/strategy:chat:stream": ["trader", "operator", "admin"],
  // Save extracted code as draft: same RBAC.
  "POST /api/strategy:draft": ["trader", "operator", "admin"],
  // Discard one draft (soft: status='deleted', kept for audit). Advisory-only
  // data — nothing builds or executes from a draft — so trader+ may do it.
  "POST /api/strategy:draft:delete": ["trader", "operator", "admin"],
  "POST /api/lease:handoff": ["operator", "admin"],
  "POST /api/kill-switch": ["operator", "admin"],
};
export function guard(route, req) {
  const roles = ALLOW[route];
  if (roles && !roles.includes(roleOf(req))) {
    return err("FORBIDDEN", `role ${roleOf(req)} cannot ${route}`, {});
  }
  return null;
}
export async function readBody(req) {
  try { return await req.json(); }
  catch { const e = new Error("invalid JSON"); e.code = "VALIDATION"; throw e; }
}
export function writeErr(e) {
  return err(e.code ?? "VALIDATION", e.message, {});
}
/** sha256Hex — hex digest of a string. An analysis run stores the digest of the
 *  EXACT request the engine was asked to analyze (input_hash), so the row is
 *  reproducible and auditable instead of opaque. WebCrypto: both workerd and
 *  node ≥18 expose globalThis.crypto.subtle. */
export async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Append one `recovery_log` incident. Lives here (not in health-route) because the
 *  health cron, the reconcile sweep (E06-T02-S3a) and the fallback poller (S3c) all
 *  write incidents — one implementation, and no module has to import another. */
export async function recordIncident(env, incident, action, actor) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO recovery_log(id,incident,action,actor,at) VALUES(?,?,?,?,?)",
  ).bind(uid("rc"), incident, action, actor, now).run();
  return { at: now };
}
