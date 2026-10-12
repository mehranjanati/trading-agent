// signals.test.mjs — E07-T01-S1: registry matrix (node:test, stdlib).
// Per kind: a golden valid payload passes with schema_version; each acceptance
// field (missing, wrong type, out-of-range, unknown field, wrong shape) throws
// with an exact $.path. OB_OS shape rejection is the task acceptance gate.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, KIND_VALIDATORS, validateSignal } from "./signals.mjs";

const GOLDEN = {
  DIVERGENCE_TRIPLE: {
    symbol: "BTCUSDT", direction: "LONG",
    legs: [{ anchor: "a", price: "67000" }, { anchor: "b", price: "67100.5" }, { anchor: "c", price: "66950" }],
    at: "2026-10-12T00:00:01Z",
  },
  ORDER_BLOCK: { symbol: "ETHUSDT", side: "BUY", zone_low: "2400", zone_high: "2410", mitigated: false },
  OB_OS: { symbol: "SOLUSDT", metric: "RSI_14", value: 78.5, threshold: 70, timeframe: "4h" },
  MTF: {
    symbol: "BTCUSDT",
    timeframes: [{ tf: "1h", bias: "LONG" }, { tf: "4h", bias: "LONG" }, { tf: "1d", bias: "FLAT" }],
    agreement: "LONG",
  },
  REGIME: { symbol: "BTCUSDT", regime: "TREND", confidence: 0.8, volatility_band: "high" },
};

describe("E07-T01-S1 registry matrix", () => {
  it("covers exactly the five ingest kinds", () => {
    assert.deepEqual(Object.keys(KIND_VALIDATORS).sort(), ["DIVERGENCE_TRIPLE", "MTF", "OB_OS", "ORDER_BLOCK", "REGIME"]);
    assert.equal(SCHEMA_VERSION, "1");
  });

  for (const [kind, payload] of Object.entries(GOLDEN)) {
    it(`${kind}: golden payload validates with schema_version`, () => {
      assert.deepEqual(validateSignal(kind, structuredClone(payload)), { ok: true, schema_version: "1" });
    });
  }

  it("unknown kind throws at $.kind", () => {
    assert.throws(() => validateSignal("NOPE", {}), (e) => e.code === "VALIDATION" && e.path === "$.kind");
  });
  it("non-object payload throws at $", () => {
    assert.throws(() => validateSignal("MTF", "x"), (e) => e.code === "VALIDATION" && e.path === "$");
  });

  it("DIVERGENCE_TRIPLE: exactly 3 legs; deep leg path", () => {
    assert.throws(() => validateSignal("DIVERGENCE_TRIPLE",
      { ...GOLDEN.DIVERGENCE_TRIPLE, legs: GOLDEN.DIVERGENCE_TRIPLE.legs.slice(0, 2) }),
      (e) => e.path === "$.legs");
    const bad = structuredClone(GOLDEN.DIVERGENCE_TRIPLE);
    bad.legs[2].price = "x";
    assert.throws(() => validateSignal("DIVERGENCE_TRIPLE", bad), (e) => e.path === "$.legs[2].price");
    const missing = structuredClone(GOLDEN.DIVERGENCE_TRIPLE);
    delete missing.at;
    assert.throws(() => validateSignal("DIVERGENCE_TRIPLE", missing), (e) => e.path === "$.at");
    assert.throws(() => validateSignal("DIVERGENCE_TRIPLE", { ...GOLDEN.DIVERGENCE_TRIPLE, extra: 1 }),
      (e) => e.path === "$.extra");
  });

  it("ORDER_BLOCK: side enum + zone decimal strings", () => {
    assert.throws(() => validateSignal("ORDER_BLOCK", { ...GOLDEN.ORDER_BLOCK, side: "HOLD" }),
      (e) => e.path === "$.side");
    assert.throws(() => validateSignal("ORDER_BLOCK", { ...GOLDEN.ORDER_BLOCK, zone_low: 2400 }),
      (e) => e.path === "$.zone_low");
  });

  it("OB_OS: unknown metric + out-of-range value + schema path", () => {
    assert.throws(() => validateSignal("OB_OS", { ...GOLDEN.OB_OS, metric: "MACD" }),
      (e) => e.code === "VALIDATION" && e.path === "$.metric");
    assert.throws(() => validateSignal("OB_OS", { ...GOLDEN.OB_OS, value: 101 }),
      (e) => e.code === "VALIDATION" && e.path === "$.value");
    assert.throws(() => validateSignal("OB_OS", { ...GOLDEN.OB_OS, value: "78" }),
      (e) => e.code === "VALIDATION" && e.path === "$.value");
    const missing = structuredClone(GOLDEN.OB_OS);
    delete missing.threshold;
    assert.throws(() => validateSignal("OB_OS", missing),
      (e) => e.code === "VALIDATION" && e.path === "$.threshold");
  });

  it("MTF: 2..4 timeframes; nested bias path", () => {
    assert.throws(() => validateSignal("MTF", { ...GOLDEN.MTF, timeframes: [GOLDEN.MTF.timeframes[0]] }),
      (e) => e.path === "$.timeframes");
    const bad = structuredClone(GOLDEN.MTF);
    bad.timeframes[1].bias = "UP";
    assert.throws(() => validateSignal("MTF", bad), (e) => e.path === "$.timeframes[1].bias");
  });

  it("REGIME: regime enum + confidence range", () => {
    assert.throws(() => validateSignal("REGIME", { ...GOLDEN.REGIME, regime: "CALM" }),
      (e) => e.path === "$.regime");
    assert.throws(() => validateSignal("REGIME", { ...GOLDEN.REGIME, confidence: 1.2 }),
      (e) => e.path === "$.confidence");
    assert.deepEqual(validateSignal("REGIME", { symbol: "BTCUSDT", regime: "RANGE" }),
      { ok: true, schema_version: "1" });
  });

  it("bad symbol form rejected on every kind", () => {
    for (const [kind, payload] of Object.entries(GOLDEN)) {
      const bad = structuredClone(payload);
      bad.symbol = "BTC-SWAP-USDT";
      assert.throws(() => validateSignal(kind, bad), (e) => e.path === "$.symbol", kind);
    }
  });
});
