// quotes.test.mjs — /api/prices: filtered + full venue reads, budget, fail-soft.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { listPrices, resetFullCache, MAX_FILTERED } from "./quotes.mjs";
import { createWindow, REST_BASE } from "./fallback-poll.mjs";

const url = (q = "") => new URL(`https://worker.dev/api/prices${q}`);
const freshWindow = () => createWindow({ budget: 3000 });
const res = (status, list) => ({ status, text: async () => JSON.stringify(list) });

describe("quotes — filtered mode", () => {
  beforeEach(resetFullCache);

  it("sends the venue (dash) form and canonicalises the answer", async () => {
    const seen = [];
    const fetchFn = async (u) => {
      const ustr = String(u);
      seen.push(ustr);
      const sym = decodeURIComponent(ustr.split("symbol=")[1] ?? "");
      return res(200, sym === "TAG-SWAP-USDT" ? [{ s: "TAG-SWAP-USDT", p: "0.0006359" }] : [{ s: "BTC-SWAP-USDT", p: "83838" }]);
    };
    const r = await listPrices({}, { url: url("?symbols=TAGUSDT,BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.match(seen[0], /symbol=TAG-SWAP-USDT$/);
    assert.match(seen[1], /symbol=BTC-SWAP-USDT$/);
    assert.equal(r.mode, "filtered");
    assert.equal(r.prices.TAGUSDT, "0.0006359");
    assert.deepEqual(r.missing, []);
  });

  it("refuses the spot echo and reports the symbol missing (venueForm guard)", async () => {
    const fetchFn = async () => res(200, [{ s: "TAGUSDT", p: "0.000635" }]); // canonical echo = spot
    const r = await listPrices({}, { url: url("?symbols=TAGUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.deepEqual(Object.keys(r.prices), []);
    assert.deepEqual(r.missing, ["TAGUSDT"]);
  });

  it("never throws for data reasons: transport failure lands in missing[]", async () => {
    const fetchFn = async () => { throw new Error("boom"); };
    const r = await listPrices({}, { url: url("?symbols=TAGUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.deepEqual(r.missing, ["TAGUSDT"]);
  });

  it("rejects a bad symbol and an over-large list with VALIDATION", async () => {
    await assert.rejects(
      listPrices({}, { url: url("?symbols=TAG-X"), fetchFn: async () => res(200, []), nowMs: 1_000, window: freshWindow() }),
      (e) => e.code === "VALIDATION",
    );
    const many = Array.from({ length: MAX_FILTERED + 1 }, (_, i) => `A${i}USDT`).join(",");
    await assert.rejects(
      listPrices({}, { url: url(`?symbols=${many}`), fetchFn: async () => res(200, []), nowMs: 1_000, window: freshWindow() }),
      (e) => e.code === "VALIDATION",
    );
  });

  it("spends the shared ADR-004 window (1 weight per symbol) and fails closed on budget", async () => {
    const win = freshWindow();
    const fetchFn = async () => res(200, [{ s: "BTC-SWAP-USDT", p: "1" }]);
    await listPrices({}, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: win });
    assert.equal(win.usage(1_000), 1);
    const empty = createWindow({ budget: 0 });
    await assert.rejects(
      listPrices({}, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: empty }),
      (e) => e.code === "RATE",
    );
  });
});

describe("quotes — full mode", () => {
  beforeEach(resetFullCache);

  it("answers the whole venue from ONE unfiltered weight-1 request, then serves the 5s cache", async () => {
    let calls = 0;
    const seen = [];
    const fetchFn = async (u) => {
      calls++;
      seen.push(String(u));
      return res(200, [{ s: "TAG-SWAP-USDT", p: "0.0006359" }, { s: "BTCUSDT", p: "1" }, { p: "2" }]);
    };
    const r1 = await listPrices({}, { url: url(), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.equal(calls, 1);
    assert.match(seen[0], /\/quote\/v1\/contract\/ticker\/price$/);
    assert.equal(r1.mode, "full");
    assert.equal(r1.prices.TAGUSDT, "0.0006359"); // canonicalised
    assert.equal(r1.prices.BTCUSDT, undefined);   // spot row refused by the venueForm guard
    assert.equal(r1.stale, false);
    const r2 = await listPrices({}, { url: url(), fetchFn, nowMs: 1_000 + 4_999, window: freshWindow() });
    assert.equal(calls, 1); // cache hit
    assert.equal(r2.cached, true);
  });

  it("serves the stale cache when the venue fails, DEGRADED when there is none", async () => {
    const good = async () => res(200, [{ s: "BTC-SWAP-USDT", p: "83838" }]);
    await listPrices({}, { url: url(), fetchFn: good, nowMs: 1_000, window: freshWindow() });
    const bad = async () => { throw new Error("venue down"); };
    const r = await listPrices({}, { url: url(), fetchFn: bad, nowMs: 10_000, window: freshWindow() });
    assert.equal(r.stale, true);
    assert.equal(r.prices.BTCUSDT, "83838");
    resetFullCache();
    await assert.rejects(
      listPrices({}, { url: url(), fetchFn: bad, nowMs: 10_000, window: freshWindow() }),
      (e) => e.code === "DEGRADED",
    );
  });

  it("a non-200 venue answer is not cached as fresh data", async () => {
    const fetchFn = async () => ({ status: 503, text: async () => "" });
    await assert.rejects(
      listPrices({}, { url: url(), fetchFn, nowMs: 1_000, window: freshWindow() }),
      (e) => e.code === "DEGRADED",
    );
  });
});
