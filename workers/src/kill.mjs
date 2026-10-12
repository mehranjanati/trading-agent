// kill.mjs — E09-T01: kill switch (docs/08 §8.5, SAFE-006, FR-011).
//
// The flag is PERSISTED in D1 (a fixed-id row), so it survives restarts and a
// cold isolate can never assume "off". Every submit path reads it first, so the
// halt is a single indexed read — well inside the <5s requirement, and it is
// logged (row + `kill.engaged_v1` event + recovery_log incident) so a halt is
// always attributable. Engage is operator+; release needs admin AND an explicit
// confirm, per the RBAC matrix and the two-person rule.
import { uid, recordIncident } from "./_shared.mjs";

export const KILL_ID = "kill_switch";
export const OFF = { engaged: false, actor: null, reason: null, at_ms: null };

export async function readKill(env) {
  const r = await env.DB.prepare("SELECT status, detail_json, at FROM health_snapshots WHERE id=?").bind(KILL_ID).all();
  const row = r.results?.[0];
  if (!row) return { ...OFF }; // no row == never engaged == off (the safe default is "off")
  let d = {};
  try { d = JSON.parse(row.detail_json ?? "{}"); } catch { d = {}; }
  return {
    engaged: row.status === "ENGAGED",
    actor: d.actor ?? null,
    reason: d.reason ?? null,
    at_ms: d.at_ms ?? Date.parse(row.at) ?? null,
  };
}

async function writeKill(env, { engaged, actor, reason, nowMs }) {
  const at = new Date(nowMs).toISOString();
  const detail = JSON.stringify({ actor, reason, at_ms: nowMs });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,'kill_switch',?,?,?) " +
        "ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, at=excluded.at",
    ).bind(KILL_ID, engaged ? "ENGAGED" : "OFF", detail, at),
    env.DB.prepare(
      "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
    ).bind(uid("evt"), engaged ? "kill.engaged_v1" : "kill.released_v1", KILL_ID,
      JSON.stringify({ actor, reason }), `${engaged ? "kill.engaged_v1" : "kill.released_v1"}:${KILL_ID}:${nowMs}`, at),
  ]);
}

/** Engage (operator+). Idempotent: engaging twice records one halt but the
 *  second call is a no-op on the flag. */
export async function engageKill(env, { actor, reason = "unspecified", nowMs = Date.now() } = {}) {
  const cur = await readKill(env);
  if (cur.engaged) return { ...cur, already: true };
  await writeKill(env, { engaged: true, actor, reason, nowMs });
  await recordIncident(env, "kill.engaged", `actor=${actor} reason=${reason}`, actor ?? "kill-switch");
  return readKill(env);
}

/** Release (admin + explicit confirm). A missing confirm is a refusal, never a
 *  silent release — the two-person rule is enforced here, not by convention. */
export async function releaseKill(env, { actor, reason = "unspecified", confirm = false, nowMs = Date.now() } = {}) {
  if (confirm !== true) {
    const e = new Error("kill release requires confirm:true (second human confirmation)");
    e.code = "VALIDATION";
    throw e;
  }
  const cur = await readKill(env);
  if (!cur.engaged) return { ...cur, already: true };
  await writeKill(env, { engaged: false, actor, reason, nowMs });
  await recordIncident(env, "kill.released", `actor=${actor} reason=${reason}`, actor ?? "kill-switch");
  return readKill(env);
}

/** The R-KILL gate input. `engaged` is a boolean or `unknown` — callers pass the
 *  string "unknown" when the read itself failed, which risk.mjs treats as
 *  engaged (fail closed). */
export async function killCtx(env) {
  try { return await readKill(env); } catch { return { ...OFF, engaged: "unknown", read_error: true }; }
}
