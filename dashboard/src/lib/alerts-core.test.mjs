// alerts-core.test.mjs — pure helpers for the Telegram alert prefs UI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOPIC_LABELS, prefsToMap, diffPrefs } from "./alerts-core.mjs";

describe("TOPIC_LABELS", () => {
  it("covers the seven backend topics, SAFETY first", () => {
    assert.equal(TOPIC_LABELS.length, 7);
    assert.equal(TOPIC_LABELS[0].topic, "SAFETY");
    const topics = TOPIC_LABELS.map((t) => t.topic);
    for (const t of ["TRIGGERED", "INVALIDATED", "ANALYSIS_READY", "APPROVAL_REQUESTED", "ORDER_UPDATE", "POSITION_DIGEST"]) {
      assert.ok(topics.includes(t), t);
    }
    // every label is non-empty Persian text
    for (const { fa } of TOPIC_LABELS) assert.ok(fa.length > 0);
  });
});

describe("prefsToMap", () => {
  it("mirrors the server default: absent = enabled", () => {
    const m = prefsToMap([{ topic: "TRIGGERED", enabled: false }]);
    assert.equal(m.TRIGGERED, false);
    assert.equal(m.SAFETY ?? true, true);
    assert.deepEqual(prefsToMap(null), {});
  });
  it("tolerates junk rows", () => {
    assert.deepEqual(prefsToMap([null, { topic: "" }, { enabled: true }]), {});
  });
});

describe("diffPrefs", () => {
  it("POSTs only what changed (server upserts exactly the delta)", () => {
    const loaded = prefsToMap([{ topic: "TRIGGERED", enabled: false }]);
    const current = { ...loaded, TRIGGERED: false }; // unchanged
    assert.deepEqual(diffPrefs(loaded, current), {});
  });
  it("detects both directions (on→off, off→on)", () => {
    const loaded = prefsToMap([{ topic: "TRIGGERED", enabled: false }]);
    const current = { ...loaded, TRIGGERED: true, SAFETY: false };
    assert.deepEqual(diffPrefs(loaded, current), { TRIGGERED: true, SAFETY: false });
  });
});
