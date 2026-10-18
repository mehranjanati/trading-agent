// routes2-lists.test.mjs — read lists the dashboard polls (were 501 before).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { miscRoutes } from "./routes2.mjs";

const rowsFor = (rows) => ({
  prepare: () => ({ all: async () => ({ results: rows }) }),
});
const req = (path) => new Request(`https://x${path}`, { method: "GET" });

describe("read lists", () => {
  it("GET /api/signals returns {signals}", async () => {
    const misc = miscRoutes();
    const res = await misc.listSignals(req("/api/signals"), { DB: rowsFor([{ id: "sig_1" }]) });
    const body = await res.json();
    assert.deepEqual(body.signals, [{ id: "sig_1" }]);
  });

  it("GET /api/analysis returns {runs}", async () => {
    const misc = miscRoutes();
    const res = await misc.listAnalysis(req("/api/analysis"), { DB: rowsFor([{ id: "an_1" }]) });
    const body = await res.json();
    assert.deepEqual(body.runs, [{ id: "an_1" }]);
  });

  it("GET /api/orders:intents returns {intents}", async () => {
    const misc = miscRoutes();
    const res = await misc.listIntents(req("/api/orders:intents"), { DB: rowsFor([{ id: "in_1" }]) });
    const body = await res.json();
    assert.deepEqual(body.intents, [{ id: "in_1" }]);
  });

  it("GET /api/orders returns {orders}", async () => {
    const misc = miscRoutes();
    const res = await misc.listOrders(req("/api/orders"), { DB: rowsFor([{ client_order_id: "co_1" }]) });
    const body = await res.json();
    assert.deepEqual(body.orders, [{ client_order_id: "co_1" }]);
  });

  it("GET /api/positions returns {positions}", async () => {
    const misc = miscRoutes();
    const res = await misc.listPositions(req("/api/positions"), { DB: rowsFor([{ symbol: "BTCUSDT" }]) });
    const body = await res.json();
    assert.deepEqual(body.positions, [{ symbol: "BTCUSDT" }]);
  });

  it("all lists degrade to [] when D1 is unreadable (never 500)", async () => {
    const misc = miscRoutes();
    const badDb = { prepare: () => ({ all: async () => { throw new Error("d1 down"); } }) };
    for (const [fn, key] of [["listSignals", "signals"], ["listAnalysis", "runs"], ["listIntents", "intents"], ["listOrders", "orders"], ["listPositions", "positions"]]) {
      const res = await misc[fn](req("/x"), { DB: badDb });
      assert.equal(res.status, 200, fn);
      assert.deepEqual((await res.json())[key], [], fn);
    }
  });
});
