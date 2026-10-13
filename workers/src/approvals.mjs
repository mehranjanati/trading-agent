// approvals.mjs — E08-T02: human approval workflow (single-use, expiring).
//
// States (docs/08 §8.3 `requested → notified → granted|rejected → consumed|expired`)
// are DERIVED from the existing columns — no migration: the analysis run is the
// request/notify phase, the row appears at the decision, and `used_at` +
// `expires_at` decide the rest. Deriving keeps one source of truth and means a
// stale row can never disagree with its own state.
//
// Single-use is enforced by the DB, not by a read-then-write race:
// `consumeApproval` writes a UNIQUE `approval.consumed_v1:<id>` event as the
// first statement of the batch. The winner inserts; a concurrent loser hits the
// UNIQUE(dedupe_key) constraint and is reported 409. If the event lands but the
// UPDATE finds the row already consumed, the confirm-read still fails closed.
//
// Fail closed (SAFE-001/002): an unreadable expiry counts as expired, a
// non-granted approval can never be consumed, and nothing here can auto-approve.
import { uid } from "./_shared.mjs";

export const TTL_MS = 600_000;      // 10m default, Q-05 (overridable by config)
export const SWEEP_MS = 60_000;     // docs/03 §3.3 approval-expiry sweeper cadence
export const SWEEP_ID = "sweep_approvals";
export const STATES = ["requested", "notified", "granted", "rejected", "consumed", "expired"];

/** The TTL comes from the active `strategy_configs` version when present
 *  (`approval_ttl_s`, seed 600), else the 10m default. */
export function ttlMsFrom(config) {
  const s = config?.approval_ttl_s;
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : TTL_MS;
}

/** Pure state derivation. `nowMs` is injected so this is deterministic. */
export function approvalState(row, nowMs = Date.now()) {
  if (!row) return null;
  if (row.used_at) return "consumed";
  if (row.decision === "reject") return "rejected";
  const exp = Date.parse(row.expires_at ?? "");
  if (!Number.isFinite(exp)) return "expired"; // unreadable expiry fails closed
  if (nowMs >= exp) return "expired";
  if (row.decision === "approve") return "granted";
  return "requested";
}

export async function readApproval(env, id) {
  const r = await env.DB.prepare("SELECT * FROM approvals WHERE id=?").bind(id).all();
  return r.results?.[0] ?? null;
}

/** List recent approvals (newest first). Read path for GET /api/approvals
 *  (dashboard approvals page); bounded at 100, no filters for paper MVP. */
export async function listApprovals(env) {
  const rows = await env.DB.prepare(
    "SELECT id, watch_id, analysis_id, decision, reason, approver, used_at, expires_at, at FROM approvals ORDER BY at DESC LIMIT 100",
  ).all().catch(() => ({ results: [] }));
  return { approvals: rows.results ?? [] };
}

/** Grant or reject an approval (the human decision). Writes the row plus its
 *  audit event in one batch, so a decision is never observable without its
 *  event. Returns the token surfaced to the client: {approval_id, watch_id,
 *  expires_at} — the identity the submit path consumes. */
export async function decideApproval(env, { id, watch_id, analysis_id, decision, reason, approver, nowMs = Date.now(), ttlMs = TTL_MS }) {
  if (decision !== "approve" && decision !== "reject") { const e = new Error("decision approve|reject"); e.code = "VALIDATION"; throw e; }
  const at = new Date(nowMs).toISOString();
  const expires_at = new Date(nowMs + ttlMs).toISOString();
  const type = decision === "approve" ? "approval.granted_v1" : "approval.rejected_v1";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO approvals(id,watch_id,analysis_id,decision,reason,approver,single_use,used_at,expires_at,at) VALUES(?,?,?,?,?,?,1,NULL,?,?)",
    ).bind(id, watch_id, analysis_id, decision, reason ?? null, approver, expires_at, at),
    env.DB.prepare(
      "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
    ).bind(uid("evt"), type, watch_id, JSON.stringify({ approval_id: id, decision, expires_at }), `${type}:${id}:0`, at),
  ]);
  return { id, decision, expires_at, state: approvalState({ decision, used_at: null, expires_at }, nowMs) };
}

/** Consume an approval exactly once. The verdict carries the HTTP status the
 *  route (and the E09 submit path) must surface. */
export async function consumeApproval(env, { approval_id, nowMs = Date.now(), actor = "submit" }) {
  const row = await readApproval(env, approval_id);
  if (!row) return { ok: false, code: "NOT_FOUND", status: 404, reason: "approval not found", state: null };
  const state = approvalState(row, nowMs);
  if (state === "rejected") return { ok: false, code: "FORBIDDEN", status: 403, reason: "approval was rejected", state };
  if (state === "expired") return { ok: false, code: "APPROVAL_EXPIRED", status: 410, reason: "approval expired", state, approval_id };
  if (state === "consumed") return { ok: false, code: "CONFLICT", status: 409, reason: "approval already consumed", state, approval_id, used_at: row.used_at };
  if (state !== "granted") return { ok: false, code: "FORBIDDEN", status: 403, reason: `approval not granted (${state})`, state };
  const at = new Date(nowMs).toISOString();
  try {
    await env.DB.batch([
      // The UNIQUE dedupe_key is the single-flight guard: exactly one winner.
      env.DB.prepare("INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)")
        .bind(uid("evt"), "approval.consumed_v1", row.watch_id,
          JSON.stringify({ approval_id, actor }), `approval.consumed_v1:${approval_id}`, at),
      env.DB.prepare("UPDATE approvals SET used_at=? WHERE id=? AND used_at IS NULL").bind(at, approval_id),
    ]);
  } catch (e) {
    const msg = `${e?.message ?? ""} ${e?.stderr ?? ""}`;
    if (/UNIQUE/i.test(msg)) {
      return { ok: false, code: "CONFLICT", status: 409, reason: "approval already consumed", state: "consumed", approval_id };
    }
    throw e;
  }
  const after = await readApproval(env, approval_id);
  if (!after?.used_at) {
    // the guard event landed but the row was already consumed by a peer
    return { ok: false, code: "CONFLICT", status: 409, reason: "approval already consumed", state: "consumed", approval_id };
  }
  return { ok: true, code: "CONSUMED", status: 200, approval_id, used_at: after.used_at, consumed_by: actor };
}

// ---------------------------------------------------------------- sweeper (S2)

/** 60s cadence marker, same fixed-id pattern as the reconcile cursor. */
export function shouldSweep(cursor, nowMs) {
  if (!cursor?.at) return true;
  const age = nowMs - Date.parse(cursor.at);
  return !Number.isFinite(age) || age >= SWEEP_MS;
}

export async function readCursor(env) {
  const row = await env.DB.prepare("SELECT at, detail_json FROM health_snapshots WHERE id=?").bind(SWEEP_ID).all();
  const last = row.results?.[0];
  if (!last) return { at: null, expired: 0, notified: 0 };
  let d = {};
  try { d = JSON.parse(last.detail_json ?? "{}"); } catch { d = {}; }
  return { at: last.at, expired: d.expired ?? 0, notified: d.notified ?? 0 };
}

async function writeCursor(env, at, { expired, notified }) {
  await env.DB.prepare(
    "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,'approvals',?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, at=excluded.at",
  ).bind(SWEEP_ID, "OK", JSON.stringify({ expired, notified }), at).run();
}

/** Mark lapsed grants as expired. Idempotent: the UNIQUE `approval.expired_v1:<id>`
 *  event is emitted at most once per approval, so re-runs (or two sweeps racing)
 *  cannot double-count. Rejections and consumed approvals are untouched. */
export async function sweepApprovals(env, { nowMs = Date.now(), actor = "approval-sweeper" } = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, watch_id, expires_at FROM approvals WHERE used_at IS NULL AND decision='approve' AND expires_at <= ?",
  ).bind(nowIso).all();
  let expired = 0;
  for (const r of rows.results ?? []) {
    try {
      await env.DB.prepare(
        "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
      ).bind(uid("evt"), "approval.expired_v1", r.watch_id,
        JSON.stringify({ approval_id: r.id, expires_at: r.expires_at }), `approval.expired_v1:${r.id}`, nowIso).run();
      expired++;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e; // already notified → idempotent
    }
  }
  await writeCursor(env, nowIso, { expired, notified: expired });
  return { expired, candidates: rows.results?.length ?? 0, at: nowIso };
}
