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
