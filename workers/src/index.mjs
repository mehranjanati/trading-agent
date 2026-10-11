// E05-T01 control API entry, E06-T01 health badge + cron wired.
// TODO(E05-T02 phase): replace X-Role stub with OIDC middleware before staging.
// D1 binding: env.DB (wrangler.toml). Local tests inject a sqlite-backed fake.
import { err } from "./errors.mjs";
import { createStore } from "./idempotency.mjs";
import { writeErr } from "./_shared.mjs";
import { watchRoutes } from "./routes.mjs";
import { miscRoutes } from "./routes2.mjs";
import { healthRoutes, tick, recordIncident } from "./health-route.mjs";

const store = createStore();
const watches = watchRoutes(store);
const misc = miscRoutes();
const health = healthRoutes();

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    try {
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
  // Signals assembled from hb keys + stream lag in E06-T02; here the seam.
  async scheduled(_event, env, _ctx) {
    const signals = {
      now_ms: Date.now(),
      go_heartbeat_ms: 0, // no heartbeat yet → DEGRADED until Go connects
      stream_lag_ms: 0,
      price_lag_ms: 0,
      d1_down: false,
    };
    const next = await tick(env, signals);
    if (next.mode !== "PRIMARY") {
      await recordIncident(env, `mode:${next.mode}`, next.reasons.join(";") || "initial", "health-cron");
    }
  },
};


