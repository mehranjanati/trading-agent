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

// RETRY_STATUSES are the answers an EDGE produces when it cannot reach the
// origin host mid-flight (2026-11-12: the quick tunnel re-registers every few
// minutes; a request straddling the gap came back 502 on the dashboard while
// the same call answered 200 seconds later). These routes are read-compute —
// a retry recomputes an analysis, it never submits an order — so one retry is
// safe and turns a tunnel blip into a normal answer.
const RETRY_STATUSES = new Set([502, 503, 504]);

async function pass(req, env, path) {
  const base = watcherBase(env);
  const url = `${base}${path}`;
  const ct = req.headers.get("content-type");
  // Buffer the body once: a retried fetch needs the SAME bytes (a consumed
  // stream cannot be replayed).
  const reqBody = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;
  let upstream;
  for (let attempt = 1; ; attempt++) {
    const init = { method: req.method, headers: {} };
    if (ct) init.headers["content-type"] = ct;
    if (reqBody !== undefined) init.body = reqBody;
    upstream = await fetch(url, init);
    if (!RETRY_STATUSES.has(upstream.status) || attempt >= 2) break;
    await upstream.arrayBuffer(); // drain the failed response, then back off once
    await new Promise((r) => setTimeout(r, 400));
  }
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
