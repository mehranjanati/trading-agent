// symbols.test.mjs — Toobit-backed symbol list: canonicalisation, cache, fail-soft.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalSymbol, parseSymbols, listSymbols, SYMBOLS_TTL_MS } from "./symbols.mjs";

const memDb = (configJson) => ({
  prepare() {
    return { all: async () => ({ results: configJson ? [{ config_json: configJson }] : [] }) };
  },
});

const kvStore = () => {
  let raw = null;
  return { get: async () => raw, put: async (k, v) => { raw = v; } };
};

const freshEnv = (configJson) => ({ DB: memDb(configJson), TOOBIT_BASE: "https://x", SYMBOLS_KV: kvStore() });

describe("symbols", () => {
  it("canonicalises the venue dash form", () => {
    assert.equal(canonicalSymbol("BTC-SWAP-USDT"), "BTCUSDT");
    assert.equal(canonicalSymbol("ETH-SWAP-USDT"), "ETHUSDT");
    assert.equal(canonicalSymbol("BTCUSDT"), "BTCUSDT");
  });

  it("parses + dedupes the raw venue list, and rejects a spot (canonical) echo", () => {
    const body = [
      { s: "BTC-SWAP-USDT", p: "67000" },
      { s: "BTCUSDT", p: "67001" }, // spot echo: dropped, not a futures market
      { s: "ETH-SWAP-USDT", p: "3500" },
      { s: "nope", p: "1" },
      { p: "2" },
    ];
    assert.deepEqual(parseSymbols(body), ["BTCUSDT", "ETHUSDT"]);
    // A list that only carries canonical (spot) rows is not a futures universe.
    assert.deepEqual(parseSymbols([{ s: "EDUUSDT", p: "0.0586" }]), []);
    // USDC-margined contracts are out of scope (USDT-M only).
    assert.deepEqual(parseSymbols([{ s: "DOGE-SWAP-USDC", p: "0.2" }]), []);
  });

  it("fetches once then serves cache within TTL", async () => {
    let calls = 0;
    const fetchFn = async () => ({ ok: true, json: async () => [{ s: "SOL-SWAP-USDT", p: "170" }] });
    const env = freshEnv(JSON.stringify({ allowlist: ["SOLUSDT"] }));
    const r1 = await listSymbols(env, { fetchFn, nowMs: 1_000 });
    assert.deepEqual(r1.symbols, ["SOLUSDT"]);
    assert.deepEqual(r1.allowlist, ["SOLUSDT"]);
    assert.equal(r1.stale, false);
    const r2 = await listSymbols(env, { fetchFn: async () => { calls++; throw new Error("must not fetch"); }, nowMs: 1_000 + SYMBOLS_TTL_MS - 1 });
    assert.deepEqual(r2.symbols, ["SOLUSDT"]);
    assert.equal(calls, 0);
  });

  it("goes stale-soft after TTL when the venue fails", async () => {
    const env = freshEnv(null);
    const good = async () => ({ ok: true, json: async () => [{ s: "BTC-SWAP-USDT", p: "1" }] });
    await listSymbols(env, { fetchFn: good, nowMs: 5_000 });
    const bad = async () => { throw new Error("venue down"); };
    const r = await listSymbols(env, { fetchFn: bad, nowMs: 5_000 + SYMBOLS_TTL_MS + 1 });
    assert.equal(r.stale, true);
    assert.deepEqual(r.symbols, ["BTCUSDT"]);
  });

  it("502-style DEGRADED when nothing cached and venue fails", async () => {
    const env = freshEnv(null);
    await assert.rejects(
      listSymbols(env, {
        fetchFn: async () => { throw new Error("down"); }, nowMs: 9_000 + SYMBOLS_TTL_MS + 1,
      }),
      (e) => e.code === "DEGRADED",
    );
  });
});
