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

/** wsPass — forward a WebSocket handshake to the Go chat plane and hand the
 *  origin's socket back to the browser.
 *
 *  WHY THIS EXISTS (2026-11-12): the dashboard's streaming turn loop dials
 *  `CHAT_WS_BASE` (default = this Worker) at /ws/chat/{id}. The Worker had no
 *  such route, so every handshake was answered by the 404 fallback, the socket
 *  closed immediately and the UI gave up after six attempts ("WebSocket
 *  Connection Failed Permanently"). This is the documented Workers
 *  WebSocket-proxy pattern: forward the handshake headers verbatim, then return
 *  the upstream 101 with its `webSocket` attached — no polling, no buffering.
 *  Advisory only: a chat turn can never create an order or an approval (D-08). */
async function wsPass(req, env, path) {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return err("VALIDATION", "WebSocket upgrade required", {});
  }
  const base = watcherBase(env);
  const upstream = await fetch(`${base}${path}`, { method: "GET", headers: req.headers });
  if (upstream.webSocket) {
    return new Response(null, { status: 101, webSocket: upstream.webSocket });
  }
  return upstream; // the origin refused the handshake: surface its answer as-is
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
    /** /api/chat/* → the Go chat service's REST companions (session state,
     *  principles). The path is forwarded verbatim so the caller's contract is
     *  the Go service's contract, not a re-typed copy. Advisory only. */
    chat: async (req, env, path) => {
      try {
        // Derive the path from the request when the caller does not pass it:
        // a missing third argument must never become "<base>undefined".
        return await pass(req, env, path ?? new URL(req.url).pathname);
      } catch (e) {
        if (e?.code === "NOT_IMPLEMENTED") return err("NOT_IMPLEMENTED", e.message, {});
        return err("DEGRADED", `go-watcher unreachable: ${e.message}`, { retryable: true });
      }
    },
    /** /ws/chat/{id} → the streaming turn loop (WebSocket upgrade). */
    chatWs: async (req, env, path) => {
      try {
        return await wsPass(req, env, path ?? new URL(req.url).pathname);
      } catch (e) {
        if (e?.code === "NOT_IMPLEMENTED") return err("NOT_IMPLEMENTED", e.message, {});
        return err("DEGRADED", `go-watcher unreachable: ${e.message}`, { retryable: true });
      }
    },
  };
}
