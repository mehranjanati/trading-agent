// approvals.test.mjs — E08-T02: single-use, expiring approvals (node:test +
// the repo's sqlite-backed fake D1). Acceptance: expired → 410 with nothing
// consumed; a race → exactly one winner, the rest 409; every transition leaves
// an audit row.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql", "migrations/0006_notify_outbox.sql", "migrations/0007_notify_prefs.sql", "migrations/0008_stop_loss.sql", "migrations/0009_slot_cap.sql", "migrations/0010_regime_filter.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
let dbFile;
function sql(q) {
  const tmp = join(tmpdir(), `e08q-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try { return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }); }
  finally { rmSync(tmp, { force: true }); }
}
function fakeDb() {
  const prep = (stmt) => ({
    _s: stmt, _a: [],
    bind(...a) { this._a = a; return this; },
    _fill() {
      let s = this._s, i = 0;
      return s.replaceAll("?", () => {
        const v = this._a[i++];
        if (v === null || v === undefined) return "NULL";
        return `'${String(v).replaceAll("'", "''")}'`;
      });
    },
    async run() { sql(this._fill()); return {}; },
    async all() {
      if (!/^\s*SELECT/i.test(this._s)) { sql(this._fill()); return { results: [] }; }
      const tmp = join(tmpdir(), `e08s-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
  });
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}
function freshEnv(extra = {}) {
  dbFile = join(tmpdir(), `e08t02-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `e08i-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
  return { DB: fakeDb(), ENV: "test", ...extra };
}
const NOW = 1_800_000_000_000;
const scalar = (q) => sql(q).trim();
const grant = (env, id = "ap_1", nowMs = NOW) =>
  import("./approvals.mjs").then(({ decideApproval }) => decideApproval(env, {
    id, watch_id: "w_1", analysis_id: "an_1", decision: "approve", approver: "trader:meh", nowMs,
  }));

describe("E08-T02-S1 approval state + single-use consume", () => {
  it("state derivation is fail-closed (unreadable expiry == expired)", async () => {
    const { approvalState } = await import("./approvals.mjs");
    assert.equal(approvalState(null), null);
    assert.equal(approvalState({ decision: "approve", expires_at: new Date(NOW + 1000).toISOString() }, NOW), "granted");
    assert.equal(approvalState({ decision: "approve", expires_at: new Date(NOW).toISOString() }, NOW), "expired");
    assert.equal(approvalState({ decision: "approve", expires_at: "soon" }, NOW), "expired");
    assert.equal(approvalState({ decision: "reject", expires_at: new Date(NOW + 1000).toISOString() }, NOW), "rejected");
    assert.equal(approvalState({ decision: "approve", used_at: "t", expires_at: new Date(NOW + 1000).toISOString() }, NOW), "consumed");
  });

  it("grant writes the row AND its audit event atomically, with the config TTL", async () => {
    const env = freshEnv();
    const out = await grant(env);
    assert.equal(out.state, "granted");
    assert.equal(out.expires_at, new Date(NOW + 600_000).toISOString());
    assert.equal(scalar("SELECT decision FROM approvals WHERE id='ap_1';"), "approve");
    assert.equal(scalar("SELECT type FROM events WHERE entity_id='w_1';"), "approval.granted_v1");
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.granted_v1';"), "1");
  });

  it("ttlMsFrom honours the active config, else the 10m default", async () => {
    const { ttlMsFrom, TTL_MS } = await import("./approvals.mjs");
    assert.equal(ttlMsFrom({ approval_ttl_s: 120 }), 120_000);
    assert.equal(ttlMsFrom({}), TTL_MS);
    assert.equal(ttlMsFrom(null), TTL_MS);
    assert.equal(ttlMsFrom({ approval_ttl_s: -5 }), TTL_MS);
  });

  it("consume once → ok, used_at set, consumed audit event", async () => {
    const env = freshEnv();
    await grant(env);
    const { consumeApproval } = await import("./approvals.mjs");
    const r = await consumeApproval(env, { approval_id: "ap_1", nowMs: NOW + 1000, actor: "trader:meh" });
    assert.equal(r.ok, true);
    assert.equal(r.code, "CONSUMED");
    assert.ok(r.used_at);
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.consumed_v1';"), "1");
  });

  it("ACCEPTANCE: expired approval → 410 and NOTHING is consumed (no intent)", async () => {
    const env = freshEnv();
    await grant(env); // expires at NOW + 600s
    const { consumeApproval } = await import("./approvals.mjs");
    const r = await consumeApproval(env, { approval_id: "ap_1", nowMs: NOW + 600_001 });
    assert.equal(r.ok, false);
    assert.equal(r.code, "APPROVAL_EXPIRED");
    assert.equal(r.status, 410);
    assert.equal(scalar("SELECT COUNT(*) FROM approvals WHERE used_at IS NOT NULL;"), "0");
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.consumed_v1';"), "0");
    assert.equal(scalar("SELECT COUNT(*) FROM order_intents;"), "0"); // no intent, ever
  });

  it("reuse → 409 (single-use), the first used_at is preserved", async () => {
    const env = freshEnv();
    await grant(env);
    const { consumeApproval } = await import("./approvals.mjs");
    const first = await consumeApproval(env, { approval_id: "ap_1", nowMs: NOW + 1000 });
    assert.equal(first.ok, true);
    const second = await consumeApproval(env, { approval_id: "ap_1", nowMs: NOW + 2000 });
    assert.equal(second.ok, false);
    assert.equal(second.code, "CONFLICT");
    assert.equal(second.status, 409);
    assert.equal(scalar("SELECT used_at FROM approvals WHERE id='ap_1';"), first.used_at);
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.consumed_v1';"), "1");
  });

  it("ACCEPTANCE: a concurrent race has exactly one winner, the rest 409", async () => {
    const env = freshEnv({ SIGNAL_HMAC_SECRET: "x" });
    await grant(env);
    const { consumeApproval } = await import("./approvals.mjs");
    const attempts = await Promise.all([
      consumeApproval(env, { approval_id: "ap_1", nowMs: NOW + 1000, actor: "a" }),
      consumeApproval(env, { approval_id: "ap_1", nowMs: NOW + 1000, actor: "b" }),
      consumeApproval(env, { approval_id: "ap_1", nowMs: NOW + 1000, actor: "c" }),
    ]);
    const wins = attempts.filter((r) => r.ok);
    const losses = attempts.filter((r) => !r.ok);
    assert.equal(wins.length, 1, "exactly one winner");
    assert.equal(losses.length, 2);
    for (const l of losses) { assert.equal(l.status, 409); assert.equal(l.code, "CONFLICT"); }
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.consumed_v1';"), "1");
    assert.equal(scalar("SELECT COUNT(*) FROM approvals WHERE used_at IS NOT NULL;"), "1");
  });

  it("a rejected approval can never be consumed (403)", async () => {
    const env = freshEnv();
    const { decideApproval, consumeApproval } = await import("./approvals.mjs");
    await decideApproval(env, { id: "ap_r", watch_id: "w_1", analysis_id: "an_1", decision: "reject", approver: "trader:meh", nowMs: NOW });
    const r = await consumeApproval(env, { approval_id: "ap_r", nowMs: NOW + 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.rejected_v1';"), "1");
  });

  it("unknown approval → 404", async () => {
    const env = freshEnv();
    const { consumeApproval } = await import("./approvals.mjs");
    assert.equal((await consumeApproval(env, { approval_id: "nope", nowMs: NOW })).status, 404);
  });
});

describe("E08-T02-S2 expiry sweeper (60s cron, idempotent audit)", () => {
  const isoSweep = async (env, nowMs) => (await import("./approvals.mjs")).sweepApprovals(env, { nowMs, actor: "test-sweeper" });

  it("marks lapsed grants and emits approval.expired_v1 exactly once", async () => {
    const env = freshEnv();
    await grant(env);
    const first = await isoSweep(env, NOW + 700_000);
    assert.equal(first.expired, 1);
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.expired_v1';"), "1");
    const second = await isoSweep(env, NOW + 900_000); // re-run: idempotent
    assert.equal(second.expired, 0);
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.expired_v1';"), "1");
  });

  it("never touches consumed or rejected approvals", async () => {
    const env = freshEnv();
    const { consumeApproval, decideApproval } = await import("./approvals.mjs");
    await grant(env, "ap_c");
    await consumeApproval(env, { approval_id: "ap_c", nowMs: NOW + 1000 });
    await decideApproval(env, { id: "ap_r", watch_id: "w_1", analysis_id: "an_1", decision: "reject", approver: "t", nowMs: NOW });
    const out = await isoSweep(env, NOW + 700_000);
    assert.equal(out.expired, 0);
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='approval.expired_v1';"), "0");
  });

  it("shouldSweep enforces the 60s cadence", async () => {
    const { shouldSweep, SWEEP_MS } = await import("./approvals.mjs");
    assert.equal(SWEEP_MS, 60_000);
    assert.equal(shouldSweep({ at: null }, NOW), true);
    assert.equal(shouldSweep({ at: new Date(NOW - 59_000).toISOString() }, NOW), false);
    assert.equal(shouldSweep({ at: new Date(NOW - 60_000).toISOString() }, NOW), true);
  });

  it("runCron drives the sweeper on its own cadence", async () => {
    const env = freshEnv();
    await grant(env);
    const { runCron } = await import("./index.mjs");
    const first = await runCron(env, { nowMs: NOW + 700_000 });
    assert.equal(first.approvals_sweep.expired, 1);
    const soon = await runCron(env, { nowMs: NOW + 700_010 }); // within 60s → skipped
    assert.equal(soon.approvals_sweep, null);
  });
});
