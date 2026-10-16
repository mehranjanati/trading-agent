// stalk.test.mjs — the setup proposal the human clicks "Stalk this zone" on.
//
// Regression this file exists for: the card rendered trigger/invalidation with
// no provenance, so a zone measured on a FAILOVER provider (okx-rest/binance-rest
// — what happens for a symbol the Toobit venue does not list, e.g. CELR) looked
// exactly like a zone measured on the venue the order would actually fill on.
// The rule now: the provider, the bar count and the newest close travel with the
// prices, and `isVenueSourced` is what the card keys its warning off.
//
// Imports the real module (stalk.ts) — Node strips the types, so the tested code
// is the shipped code, not a mirror.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proposalFromAnalyze, isVenueSourced, stalkBody } from "./stalk.ts";

const ANALYZE = (zones) => ({ id: "an_20261016T121746_2", symbol: "CELRUSDT", suggest_zones: zones });

describe("proposalFromAnalyze — prices and their provenance", () => {
  it("carries the zone's provider, bar count and newest close", () => {
    const p = proposalFromAnalyze(ANALYZE({
      trigger_long: "0.002795357142857143", inval_long: "0.0027885714285714285",
      trigger_short: "0.0027926428571428573", inval_short: "0.0027994285714285716",
      source: "okx-rest", bars: 120, last: "0.002794", last_ts: "2026-10-16T12:45:00Z",
    }), "LONG");
    assert.equal(p.symbol, "CELRUSDT");
    assert.equal(p.direction, "LONG");
    assert.equal(p.trigger_price, "0.002795357142857143");
    assert.equal(p.invalidation_price, "0.0027885714285714285");
    assert.equal(p.trigger_op, ">=");
    assert.equal(p.inval_op, "<=");
    assert.equal(p.zone_source, "okx-rest");
    assert.equal(p.zone_bars, 120);
    assert.equal(p.zone_last, "0.002794");
    assert.equal(p.zone_last_ts, "2026-10-16T12:45:00Z");
    assert.equal(p.analyze_id, "an_20261016T121746_2");
  });

  it("a SHORT proposal takes the short side and flips the operators", () => {
    const p = proposalFromAnalyze(ANALYZE({
      trigger_long: "2", inval_long: "1", trigger_short: "1.5", inval_short: "2.5", source: "toobit-rest",
    }), "SHORT");
    assert.equal(p.trigger_price, "1.5");
    assert.equal(p.invalidation_price, "2.5");
    assert.equal(p.trigger_op, "<=");
    assert.equal(p.inval_op, ">=");
  });

  it("a chat proposal has no provenance — the fields stay absent, never invented", () => {
    const p = proposalFromAnalyze(ANALYZE({ trigger_long: "2", inval_long: "1", source: undefined }), "LONG");
    assert.equal(p.zone_source, undefined);
    assert.equal(p.zone_bars, undefined);
    assert.equal(p.zone_last, undefined);
  });

  it("a malformed or missing price yields NO proposal (nothing to stalk)", () => {
    assert.equal(proposalFromAnalyze(ANALYZE({ trigger_long: "abc", inval_long: "1" }), "LONG"), null);
    assert.equal(proposalFromAnalyze(ANALYZE({ inval_long: "1" }), "LONG"), null);
    assert.equal(proposalFromAnalyze({ id: "an_1", symbol: "CELRUSDT" }, "LONG"), null);
    assert.equal(proposalFromAnalyze({ id: "an_1", symbol: "celrusdt", suggest_zones: { trigger_long: "1", inval_long: "1" } }, "LONG"), null);
  });
});

describe("isVenueSourced — only toobit-rest is the trading venue", () => {
  it("toobit-rest is the venue; failover providers are not", () => {
    assert.equal(isVenueSourced("toobit-rest"), true);
    assert.equal(isVenueSourced("okx-rest"), false);
    assert.equal(isVenueSourced("binance-rest"), false);
    assert.equal(isVenueSourced(undefined), false);
    assert.equal(isVenueSourced(""), false);
  });
});

describe("stalkBody — the POST /api/watches shape validate.mjs:watchBody accepts", () => {
  it("emits {symbol, direction, trigger{op,price}, invalidation{op,price}}", () => {
    const p = proposalFromAnalyze(ANALYZE({
      trigger_long: "0.002795357142857143", inval_long: "0.0027885714285714285", source: "okx-rest",
    }), "LONG");
    assert.deepEqual(stalkBody(p), {
      symbol: "CELRUSDT", direction: "LONG",
      trigger: { op: ">=", price: "0.002795357142857143" },
      invalidation: { op: "<=", price: "0.0027885714285714285" },
    });
  });
});
