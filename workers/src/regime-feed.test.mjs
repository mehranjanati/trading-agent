// regime-feed.test.mjs — the pure part of the index feed: CoinGecko market rows
// -> supply-weighted BTC.D / USDT.D / TOTAL3 history (+ an ETH/BTC fallback
// ratio). Network access is not exercised here; the fail-soft paths are.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIndexSeries, latestClose } from "./regime-feed.mjs";

const bars = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const row = (symbol, supply, prices) => ({ symbol, circulating_supply: supply, sparkline_in_7d: { price: prices } });
// 60 hourly bars: BTC 60k flat-ish, ETH 30k (0.5), USDT ~1, one alt.
const ROWS = [
  row("btc", 19_000_000, bars(60, () => 60_000)),
  row("eth", 120_000_000, bars(60, () => 30_000)),
  row("usdt", 120_000_000_000, bars(60, () => 1)),
  row("sol", 400_000_000, bars(60, (i) => 100 + i)),
];

describe("buildIndexSeries", () => {
  it("builds all four index series from 60 usable bars", () => {
    const s = buildIndexSeries(ROWS);
    for (const k of ["ETHBTC", "BTC.D", "USDT.D", "TOTAL3"]) {
      assert.equal(s[k].length, 60, k);
      assert.ok(s[k].every((v) => Number.isFinite(Number(v))), k);
    }
    assert.equal(Number(latestClose(s.ETHBTC)), 0.5, "ETH 30k / BTC 60k");
    const btcD = Number(latestClose(s["BTC.D"]));
    assert.ok(btcD > 0 && btcD < 1, `BTC.D is a share (${btcD})`);
    assert.ok(Number(latestClose(s["USDT.D"])) > 0);
    assert.ok(Number(latestClose(s.TOTAL3)) > 0);
  });

  it("aligns every series on the NEWEST bars (shorter window cannot shift totals)", () => {
    const btc = row("btc", 19_000_000, [...bars(10, () => 1), ...bars(60, () => 60_000)]);
    const rows = [btc, ROWS[1], ROWS[2], ROWS[3]];
    const s = buildIndexSeries(rows);
    assert.equal(s.ETHBTC.length, 60);
    // The 10 bogus 1-dollar bars are older than the aligned window and must be dropped.
    assert.equal(Number(latestClose(s.ETHBTC)), 0.5);
  });

  it("derives supply from market_cap / current_price when circulating_supply is absent", () => {
    const rows = ROWS.map((r) => ({ ...r, circulating_supply: undefined, market_cap: 1e9, current_price: 10 }));
    const s = buildIndexSeries(rows);
    assert.equal(s["BTC.D"].length, 60);
  });

  it("returns nulls (fail closed) when BTC/ETH/USDT history is missing", () => {
    for (const missing of ["btc", "eth", "usdt"]) {
      const rows = ROWS.filter((r) => r.symbol !== missing);
      const s = buildIndexSeries(rows);
      assert.deepEqual(s, { ETHBTC: null, "USDT.D": null, "BTC.D": null, TOTAL3: null }, missing);
    }
  });

  it("returns nulls when a sparkline is shorter than the EMA window", () => {
    const rows = [row("btc", 19_000_000, bars(20, () => 60_000)), ROWS[1], ROWS[2], ROWS[3]];
    const s = buildIndexSeries(rows);
    assert.equal(s.ETHBTC, null);
    assert.equal(s["BTC.D"], null);
  });

  it("returns nulls on a non-positive or non-numeric bar instead of emitting Infinity", () => {
    const rows = [row("btc", 19_000_000, bars(60, (i) => (i === 5 ? 0 : 60_000))), ROWS[1], ROWS[2], ROWS[3]];
    assert.equal(buildIndexSeries(rows).ETHBTC, null);
    const nan = [row("btc", 19_000_000, bars(60, (i) => (i === 7 ? "n/a" : 60_000))), ROWS[1], ROWS[2], ROWS[3]];
    assert.equal(buildIndexSeries(nan).ETHBTC, null);
    // null must not be coerced to 0 (Number(null) === 0).
    const hole = [row("btc", 19_000_000, bars(60, (i) => (i === 9 ? null : 60_000))), ROWS[1], ROWS[2], ROWS[3]];
    assert.equal(buildIndexSeries(hole).ETHBTC, null);
  });

  it("empty/unreachable payload => all null (UNKNOWN downstream)", () => {
    assert.deepEqual(buildIndexSeries(null), { ETHBTC: null, "USDT.D": null, "BTC.D": null, TOTAL3: null });
    assert.deepEqual(buildIndexSeries([]), { ETHBTC: null, "USDT.D": null, "BTC.D": null, TOTAL3: null });
  });
});
