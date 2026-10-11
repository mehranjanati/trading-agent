// health-route.mjs — E06-T01-S2: badge API + cron persistence.
// E06-T02-W0.2: real cron signals (Go heartbeat row + stream lag + fallback flag),
// the §6.3 rejoin gate and the heartbeat ingest route.
// GET /api/health → {mode, badge, reasons, components, at} from last snapshot row.
// GET /api/recovery/log → recent incidents.
// POST /api/health:heartbeat → Go liveness publisher (E06-T02-W0.1).
// scheduled(): 10s cron — writes health_snapshots + recovery_log on change.
import { ok, err } from "./errors.mjs";
import { evaluate, badge, canReturnToPrimary, TH } from "./health.mjs";
import { readBody, uid } from "./_shared.mjs";

// Fixed row id: the heartbeat upserts, it must never grow health_snapshots.
const HB_ID = "hb_go";

export function healthRoutes() {
  const safe = (fn) => async (req, env) => {
    try { return await fn(req, env); } catch (e) {
      const { err } = await import("./errors.mjs");
      return err("DEGRADED", e.message, {});
    }
  };
  return {
    /** POST /api/health:heartbeat — Go publisher (§6.1 5s cadence, 15s rule).
     *  Opt-in token boundary: with no GO_HEARTBEAT_TOKEN var the route is open
     *  (dev/test); when the var is set the caller must send x-agent-token. */
    heartbeat: safe(async (req, env) => {
      if (env.GO_HEARTBEAT_TOKEN && req.headers.get("x-agent-token") !== env.GO_HEARTBEAT_TOKEN) {
        return err("AUTH", "bad agent token", {});
      }
      const body = await readBody(req);
      await recordHeartbeat(env, body);
      return ok({ at: new Date().toISOString() });
    }),
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
 * lease_expires_ms, lease_holder, redis_reachable, d1_down, fallback_active,
 * kill_engaged}. `decide` may veto/rewrite the evaluated mode (rejoin gate).
 * Writes one health_snapshots row per component + recovery_log row on change. */
export async function tick(env, signals, decide = (n) => n) {
  const now = new Date().toISOString();
  const next = decide(evaluate({ ...signals, now_ms: signals.now_ms ?? Date.now() }, !!signals.kill_engaged));
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

/** Upsert the single hb_go row (E06-T02-W0.2). D1 is the only store both planes
 *  reach — the Workers side has no Redis binding — and the §6.1 semantics (5s
 *  cadence, 15s threshold) are unchanged by that storage choice. */
export async function recordHeartbeat(env, payload = {}) {
  const now = new Date().toISOString();
  const detail = JSON.stringify({
    go_heartbeat_ms: Number.isFinite(payload.go_heartbeat_ms) ? payload.go_heartbeat_ms : Date.now(),
    stream_lag_ms: Number.isFinite(payload.stream_lag_ms) ? payload.stream_lag_ms : null,
    redis_reachable: payload.redis_reachable !== false,
  });
  await env.DB.prepare(
    "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?, 'hb_go','ALIVE',?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status='ALIVE', detail_json=excluded.detail_json, at=excluded.at",
  ).bind(HB_ID, detail, now).run();
  return { at: now };
}

/** Read the heartbeat row. A missing row reads as never-seen (go_heartbeat_ms 0 →
 *  the evaluator reports `go_unhealthy`), never as healthy. */
export async function readHeartbeat(env) {
  const row = await env.DB.prepare(
    "SELECT at, detail_json FROM health_snapshots WHERE id='" + HB_ID + "'",
  ).all().catch(() => ({ results: [] }));
  const last = row.results?.[0];
  if (!last) return { go_heartbeat_ms: 0, stream_lag_ms: null, redis_reachable: true };
  let d = {};
  try { d = JSON.parse(last.detail_json ?? "{}"); } catch { d = {}; }
  const atMs = Date.parse(last.at);
  const beat = Number.isFinite(d.go_heartbeat_ms) ? d.go_heartbeat_ms : (Number.isFinite(atMs) ? atMs : 0);
  return {
    go_heartbeat_ms: beat,
    stream_lag_ms: Number.isFinite(d.stream_lag_ms) ? d.stream_lag_ms : null,
    redis_reachable: d.redis_reachable !== false,
  };
}

async function lastMode(env) {
  const row = await env.DB.prepare(
    "SELECT status, at, detail_json FROM health_snapshots WHERE component='mode' ORDER BY at DESC, rowid DESC LIMIT 1",
  ).all();
  const last = row.results?.[0];
  if (!last) return null;
  let reasons = [];
  try { reasons = JSON.parse(last.detail_json ?? "{}").reasons ?? []; } catch { reasons = []; }
  return { status: last.status, at: last.at, reasons };
}

async function lastNonPrimaryModeAt(env) {
  const row = await env.DB.prepare(
    "SELECT at FROM health_snapshots WHERE component='mode' AND status <> 'PRIMARY' ORDER BY at DESC, rowid DESC LIMIT 1",
  ).all();
  return row.results?.[0]?.at ?? null;
}

/** assembleSignals — the seam index.mjs used to hardcode (W0.2). Derives the cron
 *  signals from the heartbeat row + the mode history. Unknown sources stay null so
 *  health.mjs treats them as worst-case; per-symbol price freshness lands with the
 *  fallback poller/E07, the lease fields with the execution-authority DO (E12). */
export async function assembleSignals(env, nowMs = Date.now()) {
  let d1Down = false;
  let hb = null;
  let prevMode = null;
  let lastDownAt = null;
  try {
    hb = await readHeartbeat(env);
    prevMode = await lastMode(env);
    lastDownAt = await lastNonPrimaryModeAt(env);
  } catch { d1Down = true; }

  const goHealthy = !d1Down && (hb?.go_heartbeat_ms ?? 0) > 0 && nowMs - hb.go_heartbeat_ms <= TH.HEARTBEAT_MS * TH.MISSES;
  return {
    now_ms: nowMs,
    go_heartbeat_ms: hb?.go_heartbeat_ms ?? 0,
    stream_lag_ms: hb?.stream_lag_ms ?? null,
    redis_reachable: hb?.redis_reachable ?? true,
    price_lag_ms: 0, // no per-symbol freshness source yet — the drills inject it
    d1_down: d1Down,
    // §6.2 S1: once the system is already degraded, the fallback path is engaged.
    fallback_active: !!prevMode && prevMode.status !== "PRIMARY" && !goHealthy,
    // §6.3 condition 1: continuous healthy time since the last non-PRIMARY mode row.
    healthy_contig_ms: goHealthy ? (lastDownAt ? Math.max(0, nowMs - Date.parse(lastDownAt)) : TH.RECOVER_CONTIG_MS) : 0,
    lease_expires_ms: null,
    lease_holder: null,
    kill_engaged: false, // the kill-switch route is not part of this task's scope
  };
}

/** Rejoin inputs (§6.3 conditions 2-4). Until the reconcile sweep, the poller drain
 *  counter and the lease handoff land (S3 of this task) the defaults are unknown →
 *  the gate stays closed, so a DEGRADED system never flips back to PRIMARY on
 *  freshness alone. */
export function defaultRejoinState() {
  return { non_terminal_intents: null, fallback_inflight: null, lease_ours: null };
}

function applyRejoinGate(prev, next, signals, rejoin) {
  if (next.mode !== "PRIMARY") return next;
  if (!prev || prev.status === "PRIMARY") return next; // already steady primary
  const gate = canReturnToPrimary({
    healthy_contig_ms: signals.healthy_contig_ms,
    non_terminal_intents: rejoin.non_terminal_intents,
    fallback_inflight: rejoin.fallback_inflight,
    lease_ours: rejoin.lease_ours,
  });
  if (gate.ok) return next;
  return { ...next, mode: "DEGRADED", reasons: [...next.reasons, `rejoin_blocked(${gate.missing.join(",")})`] };
}

/** Reason-kind key: strips the measured value so only the kind remains. */
function reasonKey(status, reasons = []) {
  return `${status}|${reasons.map((r) => r.split("(")[0].split("=")[0]).join(";")}`;
}

/** runTick — cron entry (W0.2): assemble real signals → evaluate → rejoin gate →
 *  persist → log the transition, and the `health.recovered` event on return. */
export async function runTick(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const rejoin = opts.rejoin ?? defaultRejoinState();
  const prev = await lastMode(env).catch(() => null);
  const signals = await assembleSignals(env, nowMs);
  const next = await tick(env, signals, (n) => applyRejoinGate(prev, n, signals, rejoin));
  // Log a transition — or a change of reason kind while the mode holds (e.g. the
  // rejoin gate blocking a return), so the drill evidence shows why it stayed
  // degraded. Reason kinds are normalised (`go_unhealthy(hb_age=16000ms)` →
  // `go_unhealthy`) so a changing measurement never spams recovery_log.
  const changed = prev
    ? reasonKey(prev.status, prev.reasons) !== reasonKey(next.mode, next.reasons)
    : next.mode !== "PRIMARY";
  const change = changed ? { from: prev?.status ?? null, to: next.mode, reasons: next.reasons } : null;
  if (change) await recordIncident(env, `mode:${change.to}`, change.reasons.join(";") || "state change", "health-cron");
  if (prev && prev.status !== "PRIMARY" && next.mode === "PRIMARY") {
    await recordIncident(env, "health.recovered", `healthy_contig=${Math.round((signals.healthy_contig_ms ?? 0) / 1000)}s gate=ok`, "health-cron");
  }
  return { ...next, change, signals };
}
