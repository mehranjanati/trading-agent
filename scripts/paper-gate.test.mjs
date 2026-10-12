// paper-gate.test.mjs — E11-T01: the audit + gate-report verdicts (node:test).
// The 14 days themselves are a calendar wall (docs/00 S-01, docs/11 §11.1):
// nothing here fakes time — the machinery reads what a real run produced.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditIntents, auditApprovalReuse, auditUnknown, auditTerminal, gateReport, UNKNOWN_ALERT_MS } from "./paper-gate.mjs";

const NOW = 1_800_000_000_000;
const ISO = (ms) => new Date(ms).toISOString();
const OK_APPROVAL = { id: "ap_1", watch_id: "w_1", analysis_id: "an_1", decision: "approve", used_at: ISO(NOW - 1000), expires_at: ISO(NOW + 600_000), at: ISO(NOW - 60_000) };
const OK_INTENT = { id: "int_1", approval_id: "ap_1", client_order_id: "int_1", status: "FILLED", at: ISO(NOW - 500) };

describe("E11-T01 auditIntents — zero unapproved is the one number", () => {
  it("an intent with a consumed approval is ok", () => {
    const r = auditIntents([OK_INTENT], [OK_APPROVAL]);
    assert.equal(r.ok, true);
    assert.equal(r.unapproved_count, 0);
  });
  it("a MISSING approval is an unapproved order", () => {
    const r = auditIntents([{ ...OK_INTENT, approval_id: "ghost" }], [OK_APPROVAL]);
    assert.equal(r.ok, false);
    assert.equal(r.unapproved[0].verdict, "no_approval");
  });
  it("an UNUSED approval is an unapproved order (SAFE-002)", () => {
    const unused = { ...OK_APPROVAL, used_at: null };
    const r = auditIntents([OK_INTENT], [unused]);
    assert.equal(r.unapproved[0].verdict, "approval_unused");
  });
  it("a REJECTED approval can never back an order", () => {
    const rejected = { ...OK_APPROVAL, decision: "reject" };
    assert.equal(auditIntents([OK_INTENT], [rejected]).unapproved[0].verdict, "approval_not_granted");
  });
});

describe("E11-T01 auditApprovalReuse — one approval, one intent", () => {
  it("two intents on one approval is a violation", () => {
    const intents = [OK_INTENT, { ...OK_INTENT, id: "int_2", client_order_id: "int_2" }];
    const r = auditApprovalReuse(intents);
    assert.equal(r.ok, false);
    assert.deepEqual(r.reused, [{ approval_id: "ap_1", n: 2 }]);
  });
  it("RISK_REJECTED intents are exempt (recorded, not executed)", () => {
    const intents = [OK_INTENT, { ...OK_INTENT, id: "int_2", status: "RISK_REJECTED" }];
    assert.equal(auditApprovalReuse(intents).ok, true);
  });
});

describe("E11-T01 auditUnknown + auditTerminal — nothing lingers silently", () => {
  it("SUBMIT_UNKNOWN older than 5min is flagged", () => {
    const old = { ...OK_INTENT, status: "SUBMIT_UNKNOWN", at: ISO(NOW - UNKNOWN_ALERT_MS - 1) };
    const fresh = { ...OK_INTENT, id: "int_2", status: "SUBMIT_UNKNOWN", at: ISO(NOW - 1000) };
    const r = auditUnknown([old, fresh], NOW);
    assert.equal(r.ok, false);
    assert.equal(r.lingering.length, 1);
    assert.equal(r.lingering[0].intent_id, "int_1");
  });
  it("a still-live intent is visible with its age (never hidden)", () => {
    const r = auditTerminal([{ ...OK_INTENT, status: "ACKED" }], NOW);
    assert.equal(r.ok, false);
    assert.equal(r.live_count, 1);
    assert.ok(r.live[0].age_ms >= 0);
    const done = auditTerminal([OK_INTENT], NOW);
    assert.equal(done.ok, true);
  });
});

describe("E11-T01-S3 gateReport — explicit decision, human signature", () => {
  const suites = { ok: true, detail: { suites: "185 node + 9 dashboard + go + drills" } };
  it("all green → PASS, and signed_by stays null until a HUMAN signs", () => {
    const r = gateReport({ day: 14, intents: [OK_INTENT], approvals: [OK_APPROVAL], nowMs: NOW, suites });
    assert.equal(r.ok, true);
    assert.match(r.decision, /PASS/);
    assert.equal(r.signed_by, null); // the human release gate is manual
    assert.equal(r.checks.find((c) => c.name === "zero_unapproved_orders").ok, true);
  });
  it("any red check → FAIL with an explicit do-not-proceed decision", () => {
    const r = gateReport({ day: 3, intents: [{ ...OK_INTENT, approval_id: "ghost" }], approvals: [OK_APPROVAL], nowMs: NOW, suites });
    assert.equal(r.ok, false);
    assert.match(r.decision, /FAIL/);
    assert.equal(r.checks.find((c) => c.name === "zero_unapproved_orders").ok, false);
  });
  it("suites not green → FAIL even with a perfect order audit", () => {
    const r = gateReport({ day: 9, intents: [OK_INTENT], approvals: [OK_APPROVAL], nowMs: NOW, suites: { ok: false } });
    assert.equal(r.ok, false);
    assert.match(r.decision, /FAIL/);
  });
  it("paper_only: a live-flavoured env var fails the gate (SAFE-007)", () => {
    const r = gateReport({
      day: 14, intents: [OK_INTENT], approvals: [OK_APPROVAL], nowMs: NOW, suites,
      env: { LIVE_TRADING_ENABLED: "true" },
    });
    assert.equal(r.checks.find((c) => c.name === "paper_only").ok, false);
    assert.equal(r.ok, false);
  });
});