// regime.test.mjs — E11-T01: pure market-regime detector.
// Cases are the documented veto table (docs/08) plus the two behaviours the
// wiring depends on: a missing config block must NOT fail open, and a WARN (or
// a VETO downgraded to WARN) must always cost confidence.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRegime, resolveRegimeConfig, DEFAULT_REGIME_CONFIG } from "./regime.mjs";

const closes = (n) => Array.from({ length: n }, (_, i) => String(100 + i)); // monotonic up => BULLISH vs EMA
const falling = (n) => Array.from({ length: n }, (_, i) => String(100 - i));  // monotonic down => BEARISH

const cfg = (regime) => ({
  regime: {
    enabled: true,
    veto_altcoin_long: ["BEARISH", "UNKNOWN"],
    veto_altcoin_short: ["BULLISH", "UNKNOWN"],
    veto_btc_long: ["UNKNOWN"],
    veto_btc_short: ["UNKNOWN"],
    action_on_veto: "BLOCK",
    confidence_penalty: 0.3,
    ...regime,
  },
});

const prices = (ethbtc = closes(60)) => ({ ETHBTC: ethbtc, "USDT.D": null, "BTC.D": null, TOTAL3: null });
const EMPTY = { ETHBTC: null, "USDT.D": null, "BTC.D": null, TOTAL3: null };

describe("regime detector", () => {
  it("altcoin LONG + BULLISH regime => PASS", () => {
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(), config: cfg() });
    assert.equal(r.regime, "BULLISH");
    assert.equal(r.verdict, "PASS");
    assert.equal(r.force_flat, false);
    assert.equal(r.confidence_penalty, 0);
  });

  it("altcoin LONG + BEARISH regime => VETO + force_flat", () => {
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(falling(60)), config: cfg() });
    assert.equal(r.regime, "BEARISH");
    assert.equal(r.verdict, "VETO");
    assert.equal(r.force_flat, true);
    assert.match(r.reason, /regime veto/);
  });

  it("altcoin SHORT + BULLISH regime => VETO + force_flat", () => {
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "SHORT", prices: prices(), config: cfg() });
    assert.equal(r.verdict, "VETO");
    assert.equal(r.force_flat, true);
  });

  it("BTC LONG/SHORT + UNKNOWN => VETO (missing feed fails closed)", () => {
    for (const direction of ["LONG", "SHORT"]) {
      const r = evaluateRegime({ symbol: "BTCUSDT", direction, prices: EMPTY, config: cfg() });
      assert.equal(r.regime, "UNKNOWN");
      assert.equal(r.verdict, "VETO", direction);
      assert.equal(r.force_flat, true, direction);
    }
  });

  it("regime disabled => PASS, no penalty, no force_flat", () => {
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(falling(60)), config: { regime: { enabled: false } } });
    assert.equal(r.verdict, "PASS");
    assert.equal(r.force_flat, false);
    assert.equal(r.confidence_penalty, 0);
    assert.match(r.reason, /disabled/);
  });

  // ---- fail-closed defaults ----
  it("no `regime` block at all => documented defaults still veto (never fail-open)", () => {
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(falling(60)), config: {} });
    assert.equal(r.verdict, "VETO");
    assert.equal(r.force_flat, true);
    assert.match(r.reason, /veto_altcoin_long|altcoin LONG/);
  });

  it("a partial block keeps the default veto table instead of emptying it", () => {
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(falling(60)), config: { regime: { enabled: true } } });
    assert.equal(r.verdict, "VETO");
    const resolved = resolveRegimeConfig({ regime: { enabled: true } });
    assert.deepEqual(resolved.veto_altcoin_long, [...DEFAULT_REGIME_CONFIG.veto_altcoin_long]);
  });

  it("an explicit [] disables one veto edge (operator override is honoured)", () => {
    const r = evaluateRegime({
      symbol: "ETHUSDT", direction: "LONG", prices: prices(falling(60)),
      config: cfg({ veto_altcoin_long: [] }),
    });
    // BEARISH is no longer a LONG veto, so the operator's explicit override wins.
    assert.equal(r.regime, "BEARISH");
    assert.equal(r.verdict, "PASS");
    assert.equal(r.force_flat, false);
    assert.equal(r.confidence_penalty, 0);
  });

  // ---- WARN semantics ----
  it("CHOP regime => WARN with the configured confidence penalty", () => {
    // Two indices up, two down => no majority => CHOP.
    const p = { ETHBTC: closes(60), "BTC.D": falling(60), TOTAL3: closes(60), "USDT.D": falling(60) };
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: p, config: cfg() });
    assert.equal(r.regime, "CHOP");
    assert.equal(r.verdict, "WARN");
    assert.equal(r.confidence_penalty, 0.3);
    assert.match(r.reason, /confidence −30%/);
  });

  it("action_on_veto=WARN => no force_flat but the penalty still applies", () => {
    const r = evaluateRegime({
      symbol: "ETHUSDT", direction: "LONG", prices: prices(falling(60)),
      config: cfg({ action_on_veto: "WARN" }),
    });
    assert.equal(r.verdict, "VETO");
    assert.equal(r.force_flat, false);
    assert.equal(r.confidence_penalty, 0.3);
  });

  it("invalid action/penalty values normalise to BLOCK / 0.3", () => {
    const resolved = resolveRegimeConfig({ regime: { action_on_veto: "wat", confidence_penalty: 5 } });
    assert.equal(resolved.action_on_veto, "BLOCK");
    assert.equal(resolved.confidence_penalty, 0.3);
  });

  it("index detail names every reference index", () => {
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(), config: cfg() });
    assert.deepEqual(Object.keys(r.detail.index_trend).sort(), ["BTC.D", "ETHBTC", "TOTAL3", "USDT.D"]);
  });

  it("carries feed provenance into the run detail when supplied", () => {
    const withSources = {
      ...prices(),
      sources: { ETHBTC: "exchange-klines", "BTC.D": "coingecko-estimate" },
    };
    const r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: withSources, config: cfg() });
    assert.equal(r.detail.sources.ETHBTC, "exchange-klines");
    assert.equal(r.detail.sources["BTC.D"], "coingecko-estimate");
    // A feed without provenance yields null, never a guessed label.
    assert.equal(evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(), config: cfg() }).detail.sources, null);
  });
});
