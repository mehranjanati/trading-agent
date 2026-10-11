// E05-T01 control API entry, E06-T01 health badge + cron wired.
// E06-T02-W0.2: heartbeat ingest route + real cron signals + rejoin gate.
// E06-T02-S3: cron composes the reconcile sweep + lease renewal into the rejoin gate.
// TODO(E05-T02 phase): replace X-Role stub with OIDC middleware before staging.
// D1 binding: env.DB (wrangler.toml). Local tests inject a sqlite-backed fake.
import { err } from "./errors.mjs";
import { createStore } from "./idempotency.mjs";
import { writeErr, recordIncident } from "./_shared.mjs";
import { watchRoutes } from "./routes.mjs";
import { miscRoutes } from "./routes2.mjs";
import { healthRoutes, runTick, lastModeRow, readLease, renewLease } from "./health-route.mjs";
import { sweep, readCursor, shouldSweep } from "./reconcile.mjs";
import { HOLDERS, holdsAuthority } from "./lease.mjs";

const store = createStore();
const watches = watchRoutes(store);
const misc = miscRoutes();
const health = healthRoutes();

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    try {
      if (req.method === "POST" && p === "/api/health:heartbeat") return health.heartbeat(req, env);
      if (req.method === "GET" && p === "/api/health") return health.status(req, env);
      if (req.method === "GET" && p === "/api/recovery/log") return health.recoveryLog(req, env);
      if (req.method === "POST" && p === "/api/lease:handoff") return health.leaseHandoff(req, env);
      if (req.method === "GET" && p === "/api/watches/active-snapshot") return watches.snapshot(req, env);
      if (req.method === "GET" && p === "/api/watches") return watches.list(req, env);
      if (req.method === "POST" && p === "/api/watches") return watches.create(req, env);
      if (req.method === "POST" && p === "/api/signals:ingest") return misc.ingestSignal(req, env);
      if (req.method === "POST" && p === "/api/analysis:runs") return misc.runAnalysis(req, env);
      if (req.method === "POST" && p === "/api/approvals") return misc.decideApproval(req, env);
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

  // §6.3 condition 3 — the fallback drain counter arrives with S3c's poller.
  const rejoin = {
    non_terminal_intents: sweepError ? null : (swept ? swept.remaining : cursor.remaining),
    fallback_inflight: 0,
    lease_ours: leaseOurs,
  };
  const tickResult = await runTick(env, { nowMs, rejoin });
  return { tick: tickResult, rejoin, sweep: swept, sweep_error: sweepError };
}



