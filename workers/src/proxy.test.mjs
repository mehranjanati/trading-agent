// proxy.test.mjs — E14-T02: the advisory Go-plane proxy forwards to
// GO_WATCHER_URL and never 501s once the base is wired.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proxyRoutes } from "./proxy.mjs";

function req(method, path, body) {
  return new Request(`https://w.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function stubFetch(seen, status, payload) {
  globalThis.fetch = async (url, init) => {
    seen.push({ url, method: init?.method, body: init?.body });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
}

describe("go-plane proxy", () => {
  it("GET /strategies/registry forwards to the watcher base", async () => {
    const seen = [];
    stubFetch(seen, 200, { count: 1, strategies: [] });
    try {
      const proxy = proxyRoutes();
      const res = await proxy.registry(req("GET", "/strategies/registry"), { GO_WATCHER_URL: "https://go.test" });
      assert.equal(res.status, 200);
      assert.equal(seen[0].url, "https://go.test/strategies/registry");
      assert.equal(res.headers.get("x-proxied-by"), "trading-agent-control");
      const body = await res.json();
      assert.equal(body.count, 1);
    } finally {
      delete globalThis.fetch;
    }
  });

  it("POST /analyze forwards the body untouched", async () => {
    const seen = [];
    stubFetch(seen, 200, { id: "an_x", aggregate: {} });
    try {
      const proxy = proxyRoutes();
      const body = { symbol: "BTCUSDT", strategies: [{ id: "sma-cross", version: "0.2.0" }] };
      const res = await proxy.analyze(req("POST", "/analyze", body), { GO_WATCHER_URL: "https://go.test/" });
      assert.equal(res.status, 200);
      assert.equal(seen[0].url, "https://go.test/analyze");
      assert.deepEqual(JSON.parse(Buffer.from(seen[0].body).toString()), body);
    } finally {
      delete globalThis.fetch;
    }
  });

  it("unset base falls back to the baked-in watcher origin", async () => {
    const seen = [];
    stubFetch(seen, 200, { count: 1, strategies: [] });
    try {
      const proxy = proxyRoutes();
      const res = await proxy.registry(req("GET", "/strategies/registry"), {});
      assert.equal(res.status, 200);
      assert.ok(seen[0].url.startsWith("https://trading-agent-knpg.onrender.com/strategies/registry"));
    } finally {
      delete globalThis.fetch;
    }
  });

  it("explicit empty base stays 501 (never a silent hang)", async () => {
    const proxy = proxyRoutes();
    const res = await proxy.registry(req("GET", "/strategies/registry"), { GO_WATCHER_URL: "" });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.code, "NOT_IMPLEMENTED");
  });

  it("unreachable watcher degrades with a retryable 503", async () => {
    globalThis.fetch = async () => { throw new Error("boom"); };
    try {
      const proxy = proxyRoutes();
      const res = await proxy.analyze(req("POST", "/analyze", {}), { GO_WATCHER_URL: "https://go.test" });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, "DEGRADED");
      assert.equal(body.retryable, true);
    } finally {
      delete globalThis.fetch;
    }
  });

  // 2026-11-12: the dashboard showed `analyze failed: HTTP 502` while the same
  // call answered 200 seconds later — the quick tunnel re-registers and a
  // request straddling the gap gets an EDGE 5xx. One retry inside the proxy
  // turns that blip into the normal answer; read-compute only, never an order.
  it("an edge 502 is retried once and the second answer wins", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ id: "an_ok", verdicts: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const proxy = proxyRoutes();
      const res = await proxy.analyze(req("POST", "/analyze", { symbol: "BTCUSDT" }), { GO_WATCHER_URL: "https://go.test" });
      assert.equal(calls, 2, "exactly one retry");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.id, "an_ok");
    } finally {
      delete globalThis.fetch;
    }
  });

  it("two edge 5xx answers surface as the last 5xx (no infinite retry)", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("down", { status: 503 }); };
    try {
      const proxy = proxyRoutes();
      const res = await proxy.analyze(req("POST", "/analyze", {}), { GO_WATCHER_URL: "https://go.test" });
      assert.equal(calls, 2, "one retry, then give up");
      assert.equal(res.status, 503);
    } finally {
      delete globalThis.fetch;
    }
  });
});
