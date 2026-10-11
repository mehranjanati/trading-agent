// health-route.mjs — E06-T01-S2: badge API + cron persistence.
// E06-T02-W0.2: real cron signals (Go heartbeat row + stream lag + fallback flag),
// the §6.3 rejoin gate and the heartbeat ingest route.
// E06-T02-S3b: the authority lease row (handoff/renew/verify via lease.mjs).
// GET /api/health → {mode, badge, reasons, components, at} from last snapshot row.
// GET /api/recovery/log → recent incidents.
// POST /api/health:heartbeat → Go liveness publisher (E06-T02-W0.1).
// POST /api/lease:handoff → §6.3 step 4 lease handoff (operator only).
// scheduled(): 10s cron — writes health_snapshots + recovery_log on change.
import { ok, err } from "./errors.mjs";
import { evaluate, badge, canReturnToPrimary, TH } from "./health.mjs";
import { readBody, uid, roleOf, guard, recordIncident } from "./_shared.mjs";
import { createAuthority, TTL_MS, HOLDERS, holdsAuthority } from "./lease.mjs";
import { pollStatus } from "./fallback-poll.mjs";

export { recordIncident };

// Fixed row id: the heartbeat upserts, it must never grow health_snapshots.
const HB_ID = "hb_go";
// Fixed row id: the authority lease (E06-T02-S3b) — upserted, never appended.
const LEASE_ID = "lease_authority";
// Fixed row id: first moment of the current continuous PRIMARY-plane health streak
// (E06-T02-S3, §6.3 condition 1) — upserted, never appended.
const HEALTHY_ID = "healthy_since";

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
    /** POST /api/lease:handoff — §6.3 step 4 (lease handoff with epoch bump).
     *  Operator/admin only (RBAC matrix). Until the ExecutionAuthority DO binding
     *  lands (E12) this route is the local/drill seam; afterwards the DO owns the row.
     *  It transfers *authority*, never orders: the fallback order path stays blocked
     *  (`FALLBACK_ORDERS_ENABLED=false`, SAFE-001). */
    leaseHandoff: safe(async (req, env) => {
      const g = guard("POST /api/lease:handoff", req);
      if (g) return g;
      const body = await readBody(req).catch(() => ({}));
      const holder = body?.holder === HOLDERS.FALLBACK ? HOLDERS.FALLBACK : HOLDERS.PRIMARY;
      const lease = await handoffLease(env, { holder, nowMs: Date.now() });
      await recordIncident(env, "lease.handoff", `epoch=${lease.epoch} holder=${lease.holder}`, roleOf(req));
      return ok({ ...lease });
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

/** Record a mode transition in recovery_log (called by tick wrapper / operator).
 *  Implementation lives in `_shared.mjs` (re-exported here for existing callers). */

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

// ---------------------------------------------------------------- authority lease
// ADR-003 / §6.3: one holder globally, TTL 30s, renew 10s, monotonic epoch. The rules
// are NOT re-implemented here — `withAuthority` loads the D1 row into the E05-T02 state
// machine (`lease.mjs`) and persists the result, so the DO (E12) and this pre-DO seam
// share exactly one fencing implementation.

/** Read the authority lease row. null = nobody holds authority (never "us"). */
export async function readLease(env) {
  const row = await env.DB.prepare(
    "SELECT at, detail_json FROM health_snapshots WHERE id='" + LEASE_ID + "'",
  ).all();
  const last = row.results?.[0];
  if (!last) return null;
  let d = {};
  try { d = JSON.parse(last.detail_json ?? "{}"); } catch { d = {}; }
  if (!d.holder) return null;
  return { holder: d.holder, epoch: Number(d.epoch ?? 0), expires_ms: Number(d.expires_ms ?? 0), at: last.at };
}

async function writeLeaseRow(env, lease, atMs) {
  if (!lease) {
    await env.DB.prepare("DELETE FROM health_snapshots WHERE id='" + LEASE_ID + "'").run();
    return;
  }
  const detail = JSON.stringify({ holder: lease.holder, epoch: lease.epoch, expires_ms: lease.expires_ms });
  await env.DB.prepare(
    "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,'lease_authority',?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, at=excluded.at",
  ).bind(LEASE_ID, lease.holder, detail, new Date(atMs).toISOString()).run();
}

/** Run one authority operation against the D1 row through the shared state machine. */
async function withAuthority(env, nowMs, fn) {
  const cur = await readLease(env);
  const before = cur ? JSON.stringify({ holder: cur.holder, epoch: cur.epoch, expires_ms: cur.expires_ms }) : null;
  const mem = { lease: before };
  const auth = createAuthority({ get: (k) => mem[k] ?? null, set: (k, v) => { mem[k] = v; } });
  const out = fn(auth);
  if (mem.lease !== before) await writeLeaseRow(env, mem.lease ? JSON.parse(mem.lease) : null, nowMs);
  return out;
}

/** §6.3 step 4: hand authority to `holder`. An unexpired lease held by someone else is
 *  released first (a single holder is global), so the winner always gets a strictly
 *  greater epoch — the previous holder is fenced from that moment on. */
export async function handoffLease(env, { holder = HOLDERS.PRIMARY, nowMs = Date.now() } = {}) {
  return withAuthority(env, nowMs, (auth) => {
    const cur = auth.load();
    if (cur && cur.holder === holder && cur.expires_ms > nowMs) return { ok: true, ...cur, reused: true };
    if (cur && cur.expires_ms > nowMs) auth.release(cur.holder, cur.epoch);
    return auth.acquire(holder, nowMs);
  });
}

/** Renew with an explicit epoch: a zombie holder (pre-handoff epoch) is rejected with
 *  `stale-epoch` — the fencing check of §6.3 / the `lease.fenced` alert path. */
export async function renewLease(env, { holder, epoch, nowMs = Date.now() } = {}) {
  return withAuthority(env, nowMs, (auth) => auth.renew(holder, epoch, nowMs));
}

/** Fencing token check — every submit MUST pass this (ADR-003). */
export async function verifyLease(env, { holder, epoch, nowMs = Date.now() } = {}) {
  return withAuthority(env, nowMs, (auth) => auth.verify(holder, epoch, nowMs));
}

/** Renew only while `holder` still owns the row (the cron's self-renewal path). */
export async function renewLeaseIfHeld(env, { holder = HOLDERS.PRIMARY, nowMs = Date.now() } = {}) {
  const cur = await readLease(env);
  if (!holdsAuthority(cur, holder, nowMs)) return { ok: false, reason: cur ? "expired" : "no-lease" };
  return renewLease(env, { holder, epoch: cur.epoch, nowMs });
}

export async function lastModeRow(env) {
  const row = await env.DB.prepare(
    "SELECT status, at, detail_json FROM health_snapshots WHERE component='mode' ORDER BY at DESC, rowid DESC LIMIT 1",
  ).all();
  const last = row.results?.[0];
  if (!last) return null;
  let reasons = [];
  try { reasons = JSON.parse(last.detail_json ?? "{}").reasons ?? []; } catch { reasons = []; }
  return { status: last.status, at: last.at, reasons };
}

/** E06-T02-S3 (§6.3 condition 1): the PRIMARY plane is healthy — Go heartbeating within
 *  the 15s rule, Redis reachable, stream lag inside 30s and D1 answering. Separate from
 *  "mode is PRIMARY": the mode is exactly what the gate decides, so deriving the streak
 *  from mode rows is circular (a blocked tick writes non-PRIMARY and resets it). */
export function primaryPlaneHealthy(sig) {
  const goOk = (sig.go_heartbeat_ms ?? 0) > 0 && (sig.now_ms - sig.go_heartbeat_ms) <= TH.HEARTBEAT_MS * TH.MISSES;
  return !sig.d1_down && goOk && sig.redis_reachable !== false && (sig.stream_lag_ms ?? Infinity) <= TH.STREAM_LAG_MS;
}

/** Read the start of the current continuous-healthy streak (null = never recorded). */
export async function readHealthySince(env) {
  const row = await env.DB.prepare(
    "SELECT at, detail_json FROM health_snapshots WHERE id='" + HEALTHY_ID + "'",
  ).all();
  const last = row.results?.[0];
  if (!last) return null;
  let d = {};
  try { d = JSON.parse(last.detail_json ?? "{}"); } catch { d = {}; }
  const atMs = Number.isFinite(d.at_ms) ? d.at_ms : Date.parse(last.at);
  return Number.isFinite(atMs) ? { at_ms: atMs } : null;
}

async function writeHealthySince(env, atMs, healthy) {
  await env.DB.prepare(
    "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,'healthy_since',?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, at=excluded.at",
  ).bind(HEALTHY_ID, healthy ? "HEALTHY" : "UNHEALTHY", JSON.stringify({ at_ms: atMs }), new Date(atMs).toISOString()).run();
}

/** Continuous healthy time in ms: the marker is reset on every unhealthy observation and
 *  kept untouched while health holds, so a gate-blocked tick no longer resets it. */
export async function healthyContigMs(env, sig) {
  const healthy = primaryPlaneHealthy(sig);
  if (!healthy) {
    await writeHealthySince(env, sig.now_ms, false); // the streak restarts from now
    return 0;
  }
  const since = await readHealthySince(env);
  if (!since) {
    await writeHealthySince(env, sig.now_ms, true); // first healthy observation starts it
    return 0;
  }
  return Math.max(0, sig.now_ms - since.at_ms);
}

/** assembleSignals — the seam index.mjs used to hardcode (W0.2). Derives the cron
 *  signals from the heartbeat row, the mode history and the authority lease row (S3b).
 *  Unknown sources stay null so health.mjs treats them as worst-case; per-symbol
 *  fallback price freshness comes from the S3c poller status row. */
export async function assembleSignals(env, nowMs = Date.now()) {
  let d1Down = false;
  let hb = null;
  let prevMode = null;
  let lease = null;
  try {
    hb = await readHeartbeat(env);
    prevMode = await lastModeRow(env);
    lease = await readLease(env);
  } catch { d1Down = true; }

  const goHealthy = !d1Down && (hb?.go_heartbeat_ms ?? 0) > 0 && nowMs - hb.go_heartbeat_ms <= TH.HEARTBEAT_MS * TH.MISSES;
  const fallbackActive = !!prevMode && prevMode.status !== "PRIMARY" && !goHealthy;
  const sig = {
    now_ms: nowMs,
    go_heartbeat_ms: hb?.go_heartbeat_ms ?? 0,
    stream_lag_ms: hb?.stream_lag_ms ?? null,
    redis_reachable: hb?.redis_reachable ?? true,
    d1_down: d1Down,
  };
  // §6.2 S1: in fallback the only price source is the REST poller, so its snapshot age
  // IS the price freshness. With no fallback quote yet that is "stale", never fresh.
  let priceLagMs = 0; // PRIMARY: the WS/Go path owns price freshness (stream lag)
  if (fallbackActive && !d1Down) {
    try {
      const poll = await pollStatus(env, nowMs);
      priceLagMs = poll.quote_lag_ms;
    } catch { priceLagMs = TH.PRICE_STALE_MS + 1; }
  }
  // §6.3 condition 1, tracked on its own marker (never derived from the mode we are
  // deciding): a gate-blocked tick must not reset the 60s streak.
  let contigMs = 0;
  if (!d1Down) {
    try { contigMs = await healthyContigMs(env, sig); } catch { contigMs = 0; }
  }
  return {
    now_ms: nowMs,
    go_heartbeat_ms: hb?.go_heartbeat_ms ?? 0,
    stream_lag_ms: hb?.stream_lag_ms ?? null,
    redis_reachable: hb?.redis_reachable ?? true,
    price_lag_ms: priceLagMs,
    d1_down: d1Down,
    // §6.2 S1: once the system is already degraded, the fallback path is engaged.
    fallback_active: fallbackActive,
    healthy_contig_ms: contigMs,
    // §6.1: an aged authority lease is its own degradation input (renewed every 10s
    // while held; null until the first handoff, and until the DO binding at E12).
    lease_expires_ms: lease?.expires_ms ?? null,
    lease_holder: lease?.holder ?? null,
    kill_engaged: false, // the kill-switch route is not part of this task's scope
  };
}

/** Rejoin inputs (§6.3 conditions 2-4). The real values are produced by the S3 work:
 *  `non_terminal_intents` by the reconcile sweep, `fallback_inflight` by the S3c
 *  poller, `lease_ours` by the authority handoff/renewal. Defaults stay unknown (null)
 *  so a gate wired without them keeps a DEGRADED system from flipping back on
 *  freshness alone — it fails closed, never open. */
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
  const prev = await lastModeRow(env).catch(() => null);
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
