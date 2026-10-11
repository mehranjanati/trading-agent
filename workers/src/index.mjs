// E05-T01 control API entry, E06-T01 health badge + cron wired.
// E06-T02-W0.2: heartbeat ingest route + real cron signals + rejoin gate.
// TODO(E05-T02 phase): replace X-Role stub with OIDC middleware before staging.
// D1 binding: env.DB (wrangler.toml). Local tests inject a sqlite-backed fake.
import { err } from "./errors.mjs";
import { createStore } from "./idempotency.mjs";
import { writeErr } from "./_shared.mjs";
import { watchRoutes } from "./routes.mjs";
import { miscRoutes } from "./routes2.mjs";
import { healthRoutes, runTick } from "./health-route.mjs";

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
  // Signals come from the Go heartbeat row + the stream lag it reports; the
  // rejoin gate keeps a degraded system from flipping back to PRIMARY before
  // reconcile/drain/lease-handoff (supplied by this task's S3 work).
  async scheduled(_event, env, _ctx) {
    await runTick(env);
  },
};


