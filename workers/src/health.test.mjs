// health.test.mjs — E06-T01: evaluator + rejoin gate (node:test, stdlib).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate, modeChange, canReturnToPrimary, badge } from "./health.mjs";

describe("E06-T01-S1 evaluator", () => {
  it("healthy signals give PRIMARY, no reasons", () => {
    const now = 1000000;
    const r = evaluate({ now_ms: now, go_heartbeat_ms: now - 2000, stream_lag_ms: 500, price_lag_ms: 1000, d1_down: false }, false);
    assert.equal(r.mode, "PRIMARY");
    assert.deepEqual(r.reasons, []);
    assert.equal(r.components.length, 6);
  });
  it("3 missed heartbeats (15s) give DEGRADED", () => {
    const now = 1000000;
    const r = evaluate({ now_ms: now, go_heartbeat_ms: now - 16000, stream_lag_ms: 0, price_lag_ms: 0, d1_down: false }, false);
    assert.equal(r.mode, "DEGRADED");
    assert.ok(r.reasons.some((x) => x.startsWith("go_unhealthy")));
  });
  it("stale prices and stream lag degrade independently", () => {
    const now = 1000000;
    const base = { now_ms: now, go_heartbeat_ms: now - 1000, stream_lag_ms: 0, price_lag_ms: 0, d1_down: false };
    assert.equal(evaluate({ ...base, price_lag_ms: 9000 }, false).mode, "DEGRADED");
    assert.equal(evaluate({ ...base, stream_lag_ms: 45000 }, false).mode, "DEGRADED");
  });
  it("kill switch gives HALTED; D1 down gives D1_DOWN", () => {
    assert.equal(evaluate({ now_ms: 1, go_heartbeat_ms: 1, d1_down: false }, true).mode, "HALTED");
    assert.equal(evaluate({ now_ms: 1, go_heartbeat_ms: 1, d1_down: true }, false).mode, "D1_DOWN");
  });
  it("modeChange fires only on real transitions", () => {
    const next = evaluate({ now_ms: 1000000, go_heartbeat_ms: 0, stream_lag_ms: 0, price_lag_ms: 0, d1_down: false }, false);
    assert.ok(modeChange("PRIMARY", next));
    assert.equal(modeChange("DEGRADED", next), null);
  });
  it("badges match doc 09 colors; rejoin gate needs all four", () => {
    assert.deepEqual(["PRIMARY", "DEGRADED", "FALLBACK", "HALTED", "D1_DOWN"].map(badge), ["green", "amber", "orange", "red", "grey"]);
    const full = canReturnToPrimary({ healthy_contig_ms: 61000, non_terminal_intents: 0, fallback_inflight: 0, lease_ours: true });
    assert.equal(full.ok, true);
    const partial = canReturnToPrimary({ healthy_contig_ms: 61000, non_terminal_intents: 2, fallback_inflight: 0, lease_ours: true });
    assert.equal(partial.ok, false);
    assert.deepEqual(partial.missing, ["reconciled"]);
  });
});
