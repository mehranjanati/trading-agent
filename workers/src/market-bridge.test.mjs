// market-bridge.test.mjs — the Go-plane market handoff (2026-11-08).
//
// WHY THIS FILE EXISTS: Toobit answers HTTP 403 to Cloudflare's egress while
// answering the Go plane, so the Worker's catalog collapsed onto four D1 rows
// and `/api/prices` answered `prices: {}` with every symbol "missing" — no
// catalog to search, no number to show (the reported symptom). These tests pin
// the contract of the second egress: it is opt-out-able, it never throws, it
// never invents a price, and it refuses to silently truncate a long request.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMarketSymbols,
  parseMarketPrices,
  fetchMarketSymbols,
  fetchMarketPrices,
  watcherMarketBase,
  MAX_BRIDGE_SYMBOLS,
} from "./market-bridge.mjs";

const res = (status, body) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const env = (base = "https://go.example") => ({ GO_WATCHER_URL: base });

describe("market-bridge — decoding the Go plane's answers", () => {
  it("reads the catalog, upper-cases, dedupes, and refuses junk", () => {
    const body = { symbols: ["btcusdt", "ETHUSDT", "BTCUSDT", "", 42, null] };
    assert.deepEqual(parseMarketSymbols(body), ["BTCUSDT", "ETHUSDT"]);
    assert.deepEqual(parseMarketSymbols(null), []);
    assert.deepEqual(parseMarketSymbols({ symbols: "nope" }), []);
  });

  it("reads prices with their provider, and keeps unanswered symbols missing", () => {
    const body = {
      prices: [
        { symbol: "btcusdt", px: "75894.1", src: "toobit-rest" },
        { symbol: "ETHUSDT", px: "", src: "toobit-rest" }, // no price = not a price
        { symbol: "", px: "1" },
      ],
      missing: ["celrusdt"],
    };
    const got = parseMarketPrices(body);
    assert.deepEqual(got.prices, { BTCUSDT: { px: "75894.1", src: "toobit-rest", stale: false } });
    assert.deepEqual(got.missing, ["CELRUSDT"]);
  });
});

describe("market-bridge — the fetch legs", () => {
  it("is opt-out-able: an empty GO_WATCHER_URL disables the handoff", () => {
    assert.equal(watcherMarketBase({ GO_WATCHER_URL: "" }), null);
    // An unset var keeps the committed default (the same host proxy.mjs uses),
    // so a deployment that forgets the var still has a working price path.
    assert.match(String(watcherMarketBase({})), /^https:\/\//);
  });

  it("asks the Go plane for the catalog and answers null on any failure", async () => {
    const seen = [];
    const fetchFn = async (u) => {
      seen.push(String(u));
      return res(200, { symbols: ["BTCUSDT", "SOLUSDT"], source: "toobit-rest" });
    };
    assert.deepEqual(await fetchMarketSymbols(env(), { fetchFn }), ["BTCUSDT", "SOLUSDT"]);
    assert.match(seen[0], /^https:\/\/go\.example\/api\/market\/symbols$/);

    const failing = [
      async () => res(502, { code: "MARKET_UNAVAILABLE" }),
      async () => { throw new Error("plane down"); },
      async () => res(200, { symbols: [] }),
      async () => res(200, "not json"),
    ];
    for (const f of failing) {
      assert.equal(await fetchMarketSymbols(env(), { fetchFn: f }), null, "a failure is null, never an empty catalog");
    }
    assert.equal(await fetchMarketSymbols({ GO_WATCHER_URL: "" }, { fetchFn }), null, "disabled = no call");
  });

  it("asks the Go plane for exactly the symbols it was given", async () => {
    const seen = [];
    const fetchFn = async (u) => {
      seen.push(String(u));
      return res(200, { prices: [{ symbol: "BTCUSDT", px: "1.5", src: "redis-ws" }], missing: ["CELRUSDT"] });
    };
    const got = await fetchMarketPrices(env(), ["btcusdt", "CELRUSDT"], { fetchFn });
    assert.match(decodeURIComponent(seen[0]), /symbols=BTCUSDT,CELRUSDT$/);
    assert.equal(got.prices.BTCUSDT.px, "1.5");
    assert.deepEqual(got.missing, ["CELRUSDT"]);
  });

  it("refuses an over-long list instead of truncating it silently", async () => {
    const many = Array.from({ length: MAX_BRIDGE_SYMBOLS + 1 }, (_, i) => `A${i}USDT`);
    let called = false;
    const got = await fetchMarketPrices(env(), many, { fetchFn: async () => { called = true; return res(200, { prices: [] }); } });
    assert.equal(got, null);
    assert.equal(called, false, "the Go side caps at 25 — a longer ask must not be sent at all");
  });

  it("answers null when the plane refuses, so the caller keeps its own fallbacks", async () => {
    assert.equal(await fetchMarketPrices(env(), ["BTCUSDT"], { fetchFn: async () => res(403, {}) }), null);
    assert.equal(await fetchMarketPrices(env(), [], { fetchFn: async () => res(200, { prices: [] }) }), null);
    assert.equal(await fetchMarketPrices(env(), ["BTCUSDT"], { fetchFn: async () => res(200, { prices: [], missing: ["BTCUSDT"] }) }), null);
  });
});
