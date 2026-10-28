// stalk.test.mjs — the setup proposal the human clicks "Stalk this zone" on.
//
// Regression this file exists for: the card rendered trigger/invalidation with
// no provenance, so a zone measured on a FAILOVER provider (okx-rest/binance-rest
// — what happens for a symbol the Toobit venue does not list, e.g. CELR) looked
// exactly like a zone measured on the venue the order would actually fill on.
// The rule now: the provider, the bar count and the newest close travel with the
// prices, and `isVenueSourced` is what the card keys its warning off.
//
// Imports the real implementation (stalk-core.mjs) — NOT a hand-copied mirror
// and not the .ts wrapper: CI pins Node 20, which cannot load a .ts specifier,
// so a test importing `./stalk.ts` failed with ERR_UNKNOWN_FILE_EXTENSION
// before a single assertion ran. stalk.ts stays the typed surface the Svelte
// components import (the setups-core.mjs / groups-core.mjs pattern).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proposalFromAnalyze, isVenueSourced, stalkBody, bandStats, fmtPct, IN_PLAY_PCT } from "./stalk-core.mjs";

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

// The real report this pins: a CELRUSDT SHORT armed at 15:09 on a zone whose
// trigger sat 0.06% from the anchor close (band 0.31% wide) — the next tick
// decided the watch, it left ACTIVE, and every ACTIVE-only view went blank. The
// distances are now shown BEFORE the click, because a band that tight is a
// "fire now", not a "wait here".
const ARMED = proposalFromAnalyze(ANALYZE({
  trigger_short: "0.002725285714285714",
  inval_short: "0.002733857142857143",
  source: "okx-rest", bars: 120, last: "0.002727", last_ts: "2026-10-16T15:00:00Z",
}), "SHORT");

describe("bandStats — how far the armed prices sit from the zone's own close", () => {
  it("measures the CELR SHORT zone in % of its anchor close", () => {
    const b = bandStats(ARMED);
    assert.equal(b.anchor, "0.002727");
    assert.ok(Math.abs(b.trigger_pct - -0.0629) < 0.001, `trigger_pct ${b.trigger_pct}`);
    assert.ok(Math.abs(b.inval_pct - 0.2514) < 0.001, `inval_pct ${b.inval_pct}`);
    assert.ok(Math.abs(b.width_pct - 0.3143) < 0.001, `width_pct ${b.width_pct}`);
    assert.equal(b.in_play, true); // the trigger is 0.06% away: already live
  });

  it("flags a zone whose trigger the live price has not reached as NOT in play", () => {
    const far = proposalFromAnalyze(ANALYZE({
      trigger_short: "2.5", inval_short: "3.5", source: "toobit-rest", last: "3",
    }), "SHORT");
    const b = bandStats(far);
    assert.ok(Math.abs(b.trigger_pct - -16.6667) < 0.001);
    assert.ok(Math.abs(b.width_pct - 33.3333) < 0.001);
    assert.equal(b.in_play, false);
  });

  it("a LONG zone measures upward from the anchor", () => {
    const p = proposalFromAnalyze(ANALYZE({
      trigger_long: "0.002795357142857143", inval_long: "0.0027885714285714285",
      source: "okx-rest", last: "0.002794",
    }), "LONG");
    const b = bandStats(p);
    assert.ok(Math.abs(b.trigger_pct - 0.0486) < 0.001, `trigger_pct ${b.trigger_pct}`);
    assert.ok(Math.abs(b.inval_pct - -0.1945) < 0.001, `inval_pct ${b.inval_pct}`);
    // +0.049% is still inside IN_PLAY_PCT: this LONG is in play too.
    assert.equal(b.in_play, true);
  });

  it("needs an anchor: a chat proposal without zone provenance yields nothing", () => {
    assert.equal(bandStats(null), null);
    assert.equal(bandStats(undefined), null);
    assert.equal(bandStats({ ...ARMED, zone_last: undefined }), null);
    assert.equal(bandStats({ ...ARMED, zone_last: "abc" }), null);
    assert.equal(bandStats({ ...ARMED, trigger_price: "" }), null);
    assert.equal(bandStats({ ...ARMED, invalidation_price: "0" }), null);
  });

  it("IN_PLAY_PCT is the documented boundary", () => {
    const at = (pctFrom) => ({ ...ARMED, trigger_price: String(0.002727 * (1 - pctFrom / 100)) });
    assert.equal(bandStats(at(IN_PLAY_PCT / 2)).in_play, true);   // 0.05% away
    assert.equal(bandStats(at(IN_PLAY_PCT * 2)).in_play, false);  // 0.20% away
  });
});

describe("fmtPct — the card's signed percentage", () => {
  it("keeps the sign and 3 decimals", () => {
    assert.equal(fmtPct(0.2514), "+0.251%");
    assert.equal(fmtPct(-0.0629), "-0.063%");
    assert.equal(fmtPct(0), "+0.000%");
  });
});
