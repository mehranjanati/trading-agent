// outbox.test.mjs — E04-T01-S2: relay redelivery + dedupe + DLQ (node:test, stdlib).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { relayOnce, backoffMs, dueFilterSql } from "./outbox.mjs";
const row = (over = {}) => ({
  id: "obx_1", aggregate: "watches", payload_json: "{}", claimed_by: null,
  attempts: 0, next_retry: null, done: 0, ...over,
});
describe("outbox relay", () => {
  it("publishes then marks done (happy path)", async () => {
    let published = 0, done = 0;
    const r = await relayOnce([row()], { publish: async () => { published++; } },
      async () => { done++; }, async () => { throw new Error("no-defer"); });
    assert.equal(published, 1); assert.equal(done, 1);
    assert.deepEqual(r, { done: 1, deferred: 0, dlq: 0 });
  });
  it("kill-mid-publish redelivers (consumer dedupes on dedupe_key)", async () => {
    let calls = 0;
    const failOnce = { publish: async () => { if (++calls === 1) throw new Error("killed"); } };
    const deferred = [];
    const r1 = await relayOnce([row()], failOnce, async () => {}, async (id, n) => { deferred.push(n); });
    assert.equal(r1.deferred, 1);
    const r2 = await relayOnce([row({ attempts: 1 })], { publish: async () => {} },
      async () => {}, async () => {});
    assert.equal(r2.done, 1);
  });
  it("DLQ after MAX_ATTEMPTS", async () => {
    const r = await relayOnce([row({ attempts: 10 })], { publish: async () => {} },
      async () => {}, async () => {});
    assert.equal(r.dlq, 1);
  });
  it("backoff caps at 5min", () => {
    assert.equal(backoffMs(0), 1000); assert.equal(backoffMs(20), 300000);
  });
  it("due filter guards attempts + retry time", () => {
    const sql = dueFilterSql("2026-10-10T00:00:00Z");
    assert.match(sql, /attempts < 10/); assert.match(sql, /next_retry/);
  });
});
