// E05-T01 control API entry — S1/S2/S3 wired.
// TODO(E05-T02 phase): replace X-Role stub with OIDC middleware before staging.
// D1 binding: env.DB (wrangler.toml). Local tests inject a sqlite-backed fake.
import { err, ok } from "./errors.mjs";
import { createStore } from "./idempotency.mjs";
import { writeErr } from "./_shared.mjs";
import { watchRoutes } from "./routes.mjs";
import { miscRoutes } from "./routes2.mjs";

const store = createStore();
const watches = watchRoutes(store);
const misc = miscRoutes();

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    try {
      if (req.method === "GET" && p === "/api/health") {
        return ok({ ok: true, mode: "paper", env: env.ENV ?? "dev", e05: "live" });
      }
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
};

