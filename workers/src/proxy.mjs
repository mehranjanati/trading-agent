// proxy.mjs — E14-T02: the Worker proxies advisory Go-plane routes to the
// go-watcher origin (Render). WHY A PROXY: the Pages dashboard bakes
// VITE_ANALYZE_BASE at build time; when it is unset the dashboard falls back
// to the Worker URL itself. These two routes forward it there instead of 501.
//
// ADVISORY ONLY (D-08): /analyze and /strategies/registry never create
// orders/approvals — the Go plane is read-compute only. No auth is added:
// the routes were public on the watcher and stay public here.
import { err, corsFor } from "./errors.mjs";

// DEFAULT_WATCHER_URL is the baked-in go-watcher origin (Render) used when
// GO_WATCHER_URL is unset. It mirrors the same base committed in the root
// wrangler.toml [vars] and workers/wrangler.toml-adjacent deploys: keep all
// three in sync when the watcher host moves.
export const DEFAULT_WATCHER_URL = "https://trading-agent-knpg.onrender.com";

// watcherBase resolves the go-watcher origin for every advisory call to the Go
// plane — the proxy routes below AND the live-engine analysis run
// (routes2.mjs:runAnalysis). Exported so the two callers can never drift onto
// different bases.
export function watcherBase(env) {
  const base = String(env.GO_WATCHER_URL ?? DEFAULT_WATCHER_URL).replace(/\/+$/, "");
  if (!base) {
    const e = new Error("go-watcher not wired (set GO_WATCHER_URL)");
    e.code = "NOT_IMPLEMENTED";
    throw e;
  }
  return base;
}

async function pass(req, env, path) {
  const base = watcherBase(env);
  const url = `${base}${path}`;
  const init = { method: req.method, headers: {} };
  const ct = req.headers.get("content-type");
  if (ct) init.headers["content-type"] = ct;
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  const upstream = await fetch(url, init);
  const body = await upstream.arrayBuffer();
  const headers = corsFor(req);
  const uctype = upstream.headers.get("content-type");
  if (uctype) headers["content-type"] = uctype;
  headers["x-proxied-by"] = "trading-agent-control";
  return new Response(body, { status: upstream.status, headers });
}

export function proxyRoutes() {
  return {
    /** GET /strategies/registry → the pinned-WASM catalog from Go. */
    registry: async (req, env) => {
      try {
        return await pass(req, env, "/strategies/registry");
      } catch (e) {
        if (e?.code === "NOT_IMPLEMENTED") return err("NOT_IMPLEMENTED", e.message, {});
        return err("DEGRADED", `go-watcher unreachable: ${e.message}`, { retryable: true });
      }
    },
    /** POST /analyze → deep WASM analysis from Go (advisory only). */
    analyze: async (req, env) => {
      try {
        return await pass(req, env, "/analyze");
      } catch (e) {
        if (e?.code === "NOT_IMPLEMENTED") return err("NOT_IMPLEMENTED", e.message, {});
        return err("DEGRADED", `go-watcher unreachable: ${e.message}`, { retryable: true });
      }
    },
  };
}
