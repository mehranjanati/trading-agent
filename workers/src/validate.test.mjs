// validate.test.mjs — request-body validators (pure, stdlib only).
// The intent body is the ONLY client-supplied part of the order path
// (docs/10 §10.2); every field it accepts is checked before any write.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { intentBody, watchBody, approvalBody } from "./validate.mjs";

describe("intentBody (the order request)", () => {
  const ok = { approval_id: "ap_1", side: "BUY", qty: "1", leverage: 5 };

  it("accepts a minimal valid body", () => {
    assert.equal(intentBody({ ...ok }), true);
  });

  it("accepts an optional decimal stop_loss", () => {
    assert.equal(intentBody({ ...ok, stop_loss: "90" }), true);
    assert.equal(intentBody({ ...ok, stop_loss: "90.5" }), true);
    assert.equal(intentBody({ ...ok, stop_loss: null }), true); // null == absent
  });

  it("rejects a non-decimal stop_loss (never a float, never a number)", () => {
    for (const stop_loss of ["abc", "1e3", "-90", "90,5", 90]) {
      assert.throws(() => intentBody({ ...ok, stop_loss }), (e) => e.code === "VALIDATION", String(stop_loss));
    }
  });

  it("requires approval_id, side, qty and leverage", () => {
    assert.throws(() => intentBody({ ...ok, approval_id: "" }), (e) => e.code === "VALIDATION");
    assert.throws(() => intentBody({ ...ok, side: "HOLD" }), (e) => e.code === "VALIDATION");
    assert.throws(() => intentBody({ ...ok, qty: "1.0e3" }), (e) => e.code === "VALIDATION");
    assert.throws(() => intentBody({ ...ok, leverage: 0 }), (e) => e.code === "VALIDATION");
    assert.throws(() => intentBody({ ...ok, leverage: 101 }), (e) => e.code === "VALIDATION");
    assert.throws(() => intentBody({ ...ok, leverage: 1.5 }), (e) => e.code === "VALIDATION");
  });
});

describe("watchBody / approvalBody stay strict", () => {
  it("watchBody rejects an unknown symbol shape and an unknown trigger op", () => {
    assert.throws(() => watchBody({ symbol: "btcusdt", direction: "LONG", trigger: { op: ">=", price: "1" } }), (e) => e.code === "VALIDATION");
    assert.throws(() => watchBody({ symbol: "BTCUSDT", direction: "LONG", trigger: { op: "??", price: "1" } }), (e) => e.code === "VALIDATION");
  });

  it("approvalBody accepts only approve|reject", () => {
    assert.equal(approvalBody({ watch_id: "w1", analysis_id: "a1", decision: "approve" }), true);
    assert.throws(() => approvalBody({ watch_id: "w1", analysis_id: "a1", decision: "maybe" }), (e) => e.code === "VALIDATION");
  });
});
