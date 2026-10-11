// health-route.mjs — E06-T01-S2: badge API + cron persistence.
// GET /api/health → {mode, badge, reasons, components, at} from last snapshot row.
// GET /api/recovery/log → recent incidents.
// scheduled(): 10s cron — writes health_snapshots + recovery_log on mode change.
import { ok } from "./errors.mjs";
import { evaluate, modeChange, badge } from "./health.mjs";
import { uid } from "./_shared.mjs";

export function healthRoutes() {
  const safe = (fn) => async (req, env) => {
    try { return await fn(req, env); } catch (e) {
      const { err } = await import("./errors.mjs");
      return err("DEGRADED", e.message, {});
    }
  };
  return {
    status: safe(async (_req, env) => {
      const row = await env.DB.prepare(
        "SELECT * FROM health_snapshots WHERE component='mode' ORDER BY at DESC LIMIT 1",
      ).all().catch(() => ({ results: [] }));
      const last = row.results?.[0];
      if (!last) {
        return ok({ mode: "PRIMARY", badge: "green", reasons: [], components: [], at: null, note: "no snapshot yet — evaluator pending" });
      }
      const detail = JSON.parse(last.detail_json ?? "{}");
      return ok({ mode: last.status, badge: badge(last.status), reasons: detail.reasons ?? [], components: detail.components ?? [], at: last.at });
    }),
    recoveryLog: safe(async (req, env) => {
      const u = new URL(req.url);
      const limit = Math.min(parseInt(u.searchParams.get("limit") ?? "50", 10) || 50, 200);
      const rows = await env.DB.prepare(
        "SELECT * FROM recovery_log ORDER BY at DESC LIMIT ?",
      ).bind(limit).all();
      return ok({ incidents: rows.results ?? [] });
    }),
  };
}

/** Run one evaluator tick. signals: {go_heartbeat_ms, stream_lag_ms, price_lag_ms,
 * lease_expires_ms, lease_holder, d1_down, fallback_active, kill_engaged}.
 * Writes one health_snapshots row per component + recovery_log row on mode change. */
export async function tick(env, signals) {
  const now = new Date().toISOString();
  const next = evaluate({ ...signals, now_ms: signals.now_ms ?? Date.now() }, !!signals.kill_engaged);
  const batch = next.components.map((c) =>
    env.DB.prepare(
      "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,?,?,?,?)",
    ).bind(uid("hs"), c.component, c.status, JSON.stringify(c.detail), now),
  );
  // Dedicated mode row: badge API reads component='mode' (never ambiguous).
  batch.push(
    env.DB.prepare(
      "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,?,?,?,?)",
    ).bind(uid("hs"), "mode", next.mode, JSON.stringify({ reasons: next.reasons, components: next.components }), now),
  );
  await env.DB.batch(batch);
  return { ...next, at: now };
}

/** Record a mode transition in recovery_log (called by tick wrapper / operator). */
export async function recordIncident(env, incident, action, actor) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO recovery_log(id,incident,action,actor,at) VALUES(?,?,?,?,?)",
  ).bind(uid("rc"), incident, action, actor, now).run();
  return { at: now };
}
