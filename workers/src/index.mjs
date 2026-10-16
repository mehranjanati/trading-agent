// E05-T01 control API entry, E06-T01 health badge + cron wired.
// E06-T02-W0.2: heartbeat ingest route + real cron signals + rejoin gate.
// E06-T02-S3: cron composes the reconcile sweep + lease renewal into the rejoin gate.
// TODO(E05-T02 phase): replace X-Role stub with OIDC middleware before staging.
// D1 binding: env.DB (wrangler.toml). Local tests inject a sqlite-backed fake.
import { ok, err, CORS, corsFor } from "./errors.mjs";
import { createStore } from "./idempotency.mjs";
import { writeErr, recordIncident } from "./_shared.mjs";
import { watchRoutes } from "./routes.mjs";
import { miscRoutes } from "./routes2.mjs";
import { healthRoutes, runTick, lastModeRow, readLease, renewLease } from "./health-route.mjs";
import { sweep, readCursor, shouldSweep } from "./reconcile.mjs";
import { sweepApprovals, readCursor as readApprovalCursor, shouldSweep as shouldSweepApprovals } from "./approvals.mjs";
import { HOLDERS, holdsAuthority } from "./lease.mjs";
import { tick as pollOnce, pollStatus } from "./fallback-poll.mjs";
import { generateRoutes } from "./strategies-ai.mjs";
import { proxyRoutes } from "./proxy.mjs";
import { listSymbols } from "./symbols.mjs";

const store = createStore();
const watches = watchRoutes(store);
const misc = miscRoutes();
const health = healthRoutes();
const ai = generateRoutes();
const proxy = proxyRoutes();

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    // E12-T01: CORS preflight — reads get the base allow-list; a preflight
    // asking for POST gets allow-methods: POST only on the advisory paths
    // (chat/generate/draft/watches). Orders/approvals stay fail closed (D-08).
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsFor(req) });
    try {
      if (req.method === "POST" && p === "/api/health:heartbeat") return health.heartbeat(req, env);
      if (req.method === "GET" && p === "/api/health") return health.status(req, env);
      if (req.method === "GET" && p === "/api/recovery/log") return health.recoveryLog(req, env);
      if (req.method === "POST" && p === "/api/lease:handoff") return health.leaseHandoff(req, env);
      if (req.method === "GET" && p === "/api/watches/active-snapshot") return watches.snapshot(req, env);
      if (req.method === "GET" && p === "/api/watches") return watches.list(req, env);
      if (req.method === "POST" && p === "/api/watches") return watches.create(req, env);
      if (req.method === "POST" && p === "/api/signals:ingest") return misc.ingestSignalWebhook(req, env);
      if (req.method === "POST" && p === "/api/strategy:activate") return misc.activateStrategy(req, env);
      if (req.method === "POST" && p === "/api/orders:intents") return misc.submitIntent(req, env);
      if (req.method === "POST" && p === "/api/kill-switch") return misc.killSwitch(req, env);
      if (req.method === "POST" && p === "/api/analysis:runs") return misc.runAnalysis(req, env);
      if (req.method === "POST" && p === "/api/watches:trigger") return misc.triggerWatch(req, env);
      if (req.method === "POST" && p === "/api/approvals") return misc.decideApproval(req, env);
      if (req.method === "GET" && p === "/api/strategy") return misc.listStrategy(req, env);
      if (req.method === "GET" && p === "/api/approvals") return misc.listApprovals(req, env);
      if (req.method === "GET" && p === "/api/signals") return misc.listSignals(req, env);
      if (req.method === "GET" && p === "/api/analysis") return misc.listAnalysis(req, env);
      if (req.method === "GET" && p === "/api/orders:intents") return misc.listIntents(req, env);
      if (req.method === "GET" && p === "/api/positions") return misc.listPositions(req, env);
      if (req.method === "GET" && p === "/api/symbols") {
        try {
          return ok({ ...(await listSymbols(env)), at: new Date().toISOString() });
        } catch (e) {
          return writeErr(e);
        }
      }
      if (req.method === "POST" && p === "/api/strategy:generate") return ai.generate(req, env);
      if (req.method === "POST" && p === "/api/strategy:chat") return ai.chat(req, env);
      if (req.method === "POST" && p === "/api/strategy:chat:stream") return ai.chatStream(req, env);
      if (req.method === "POST" && p === "/api/strategy:draft") return ai.saveDraft(req, env);
      if (req.method === "GET" && p === "/api/strategy:drafts") return ai.drafts(req, env);
      // E14-T02: advisory Go-plane routes proxied to go-watcher (Render) when
      // the dashboard was built without VITE_ANALYZE_BASE. Advisory, no orders.
      if (req.method === "GET" && p === "/strategies/registry") return proxy.registry(req, env);
      if (req.method === "POST" && p === "/analyze") return proxy.analyze(req, env);
      return err("NOT_IMPLEMENTED", `${req.method} ${p} lands in a later task`, {});
    } catch (e) {
      return writeErr(e);
    }
  },
  // 10s health evaluator cron (wrangler [triggers] crons = "*/10 * * * * *").
  async scheduled(_event, env, _ctx) {
    await runCron(env);
  },
};

/** runCron — one §6.3 pass: refresh the rejoin inputs, then evaluate and persist.
 *  Order matters: the sweep produces the count the gate reads, and the holder renews
 *  before the tick judges return-to-primary. Every input fails closed — an unreadable
 *  sweep or lease leaves the corresponding gate condition unsatisfied, never satisfied. */
export async function runCron(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const prev = await lastModeRow(env).catch(() => null);
  const mode = prev?.status ?? "PRIMARY";

  // §6.3 condition 2 — §6.5 reconcile sweep (15s cadence, every tick while degraded).
  let cursor = { at: null, remaining: null, resolved: null, complete_reported: 0 };
  let swept = null;
  let sweepError = null;
  try {
    cursor = await readCursor(env);
    if (shouldSweep(cursor, nowMs, mode)) {
      swept = await sweep(env, { nowMs, mode, resolve: opts.resolve, cursor, actor: opts.actor ?? "health-cron" });
    }
  } catch (e) {
    sweepError = e.message; // unknown inventory → the gate stays closed
  }

  // §6.3 condition 4 — the holder renews; a stale epoch is the `lease.fenced` alert.
  let leaseOurs = false;
  try {
    const lease = await readLease(env);
    if (holdsAuthority(lease, HOLDERS.PRIMARY, nowMs)) {
      const renew = await renewLease(env, { holder: HOLDERS.PRIMARY, epoch: lease.epoch, nowMs });
      leaseOurs = renew.ok === true;
      if (renew.reason === "stale-epoch") {
        await recordIncident(env, "lease.fenced", `epoch=${lease.epoch} holder=${HOLDERS.PRIMARY}`, "health-cron");
      }
    }
  } catch { leaseOurs = false; }

  // §6.3 condition 3 — the fallback must have drained. The in-flight marker is read
  // BEFORE the tick (that is the state the gate reasons about) and the poll round is
  // driven AFTER it with the freshly evaluated mode, so polling starts on the same tick
  // the system degrades instead of one cron late (ADR-004: poll only while the primary
  // plane is down; in fallback this is also the only price feed).
  let drained = false;
  try { drained = (await pollStatus(env, nowMs)).drained; } catch { drained = false; }

  const rejoin = {
    non_terminal_intents: sweepError ? null : (swept ? swept.remaining : cursor.remaining),
    fallback_inflight: drained ? 0 : 1,
    lease_ours: leaseOurs,
  };
  const tickResult = await runTick(env, { nowMs, rejoin });

  let poll = null;
  try {
    const round = await pollOnce(env, {
      nowMs, mode: tickResult.mode, window: opts.window, symbols: opts.symbols,
      get: opts.get, baseUrl: opts.baseUrl, actor: opts.actor ?? "health-cron",
    });
    poll = { ...(await pollStatus(env, nowMs)), round: round.reason };
  } catch (e) {
    poll = { drained: false, round: "error", error: e.message }; // unknown → not drained
  }

  // §3.3 approval-expiry sweeper on its own 60s cadence (same 10s cron, gated).
  // Idempotent: the UNIQUE approval.expired_v1 event fires once per approval.
  let approvalsSweep = null;
  try {
    const acursor = await readApprovalCursor(env);
    if (shouldSweepApprovals(acursor, nowMs)) {
      approvalsSweep = await sweepApprovals(env, { nowMs, actor: opts.actor ?? "approval-sweeper" });
    }
  } catch (e) {
    approvalsSweep = { error: e.message };
  }
  return { tick: tickResult, rejoin, sweep: swept, sweep_error: sweepError, poll, approvals_sweep: approvalsSweep };
}



