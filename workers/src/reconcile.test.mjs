// reconcile.test.mjs — E06-T02-S3a: §6.5 reconcile sweep + §6.3 rejoin ordering.
// sqlite-backed fake D1, same harness shape as health-heartbeat.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDERS } from "./lease.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql", "migrations/0006_notify_outbox.sql", "migrations/0007_notify_prefs.sql", "migrations/0008_stop_loss.sql", "migrations/0009_slot_cap.sql", "migrations/0010_regime_filter.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

let dbFile = "";
function sql(q) {
  const tmp = join(tmpdir(), `rq-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try { return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }); }
  finally { rmSync(tmp, { force: true }); }
}
/** Read one scalar as a number (COUNT(*) etc.). */
const scalar = (q) => Number(sql(q).trim() || 0);
const iso = (ms) => new Date(ms).toISOString();

function fakeDb() {
  const prep = (stmt) => ({
    _s: stmt, _a: [],
    bind(...a) { this._a = a; return this; },
    _fill() {
      let i = 0;
      return this._s.replaceAll("?", () => {
        const v = this._a[i++];
        if (v === null || v === undefined) return "NULL";
        return `'${String(v).replaceAll("'", "''")}'`;
      });
    },
    async all() {
      if (!/^\s*SELECT/i.test(this._s)) { sql(this._fill()); return { results: [] }; }
      const tmp = join(tmpdir(), `rsel-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
    async run() { sql(this._fill()); return {}; },
  });
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}

/** Fresh migrated sqlite DB per test — no cross-test state. */
function freshEnv(extra = {}) {
  dbFile = join(tmpdir(), `e06t02r-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `rinit-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  try { execSync(`sqlite3 ${dbFile} < "${tmp}"`); } finally { rmSync(tmp, { force: true }); }
  return { DB: fakeDb(), ENV: "test", ...extra };
}

/** D1 that fails every read: the cron must fail closed, never "all clear". */
function brokenEnv() {
  const prep = () => ({
    bind: () => ({ run: async () => ({}) }),
    all: async () => { throw new Error("d1 unavailable"); },
    run: async () => ({}),
  });
  return { DB: { prepare: prep, batch: async (l) => { for (const s of l) await s.run(); } }, ENV: "test" };
}

function seedIntent({ id, approval_id, client_order_id, status, at }) {
  sql(`INSERT INTO order_intents(id,watch_id,approval_id,side,qty,leverage,client_order_id,status,at) ` +
    `VALUES('${id}','w1','${approval_id}','BUY','1',5,'${client_order_id}','${status}','${at}');`);
}
function seedOrder({ client_order_id, at, status = "SUBMITTED" }) {
  sql(`INSERT INTO orders(client_order_id,exchange_order_id,status,fills_json,last_reconciled_at,at) ` +
    `VALUES('${client_order_id}',NULL,'${status}','[]',NULL,'${at}');`);
}

describe("E06-T02-S3a sweep inventory + cadence", () => {
  it("sweeps on a 15s cursor age, and on every tick while degraded", async () => {
    const { shouldSweep, SWEEP_MS } = await import("./reconcile.mjs");
    const now = Date.now();
    assert.equal(SWEEP_MS, 15_000);
    assert.equal(shouldSweep({ at: null }, now, "PRIMARY"), true); // first sweep ever
    assert.equal(shouldSweep({ at: iso(now - 14_000) }, now, "PRIMARY"), false);
    assert.equal(shouldSweep({ at: iso(now - 15_000) }, now, "PRIMARY"), true);
    assert.equal(shouldSweep({ at: iso(now - 1_000) }, now, "DEGRADED"), true); // every tick
    assert.equal(shouldSweep({ at: iso(now - 1_000) }, now, "FALLBACK"), true);
  });

  it("inventory lists exactly the four non-terminal states (§6.5)", async () => {
    const { NON_TERMINAL, TERMINAL, intentInventorySql } = await import("./reconcile.mjs");
    assert.deepEqual(NON_TERMINAL, ["SUBMITTED", "SUBMIT_UNKNOWN", "ACKED", "PARTIAL"]);
    assert.deepEqual(TERMINAL, ["FILLED", "REJECTED", "CANCELLED", "EXPIRED"]);
    for (const s of NON_TERMINAL) assert.match(intentInventorySql(), new RegExp(`'${s}'`));
    for (const s of TERMINAL) assert.doesNotMatch(intentInventorySql(), new RegExp(`'${s}'`));
  });
});

describe("E06-T02-S3a sweep resolution", () => {
  it("resolves all four non-terminal states → orders + events + outbox + reconcile.complete", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { sweep } = await import("./reconcile.mjs");
    const map = { SUBMITTED: "FILLED", SUBMIT_UNKNOWN: "REJECTED", ACKED: "CANCELLED", PARTIAL: "EXPIRED" };
    const statuses = Object.keys(map);
    statuses.forEach((status, i) =>
      seedIntent({ id: `i${i}`, approval_id: `a${i}`, client_order_id: `c${i}`, status, at: iso(now - 60_000) }));

    const out = await sweep(env, {
      nowMs: now,
      mode: "DEGRADED",
      resolve: { intent: (row) => ({ status: map[row.status], exchange_order_id: `ex-${row.id}`, fills: [{ px: "1" }] }) },
    });

    assert.equal(out.swept, 4);
    assert.equal(out.resolved, 4);
    assert.equal(out.remaining, 0);
    assert.equal(out.certified, true);
    assert.deepEqual(
      sql("SELECT status FROM order_intents ORDER BY id;").trim().split("\n").sort(),
      ["CANCELLED", "EXPIRED", "FILLED", "REJECTED"],
    );
    assert.equal(scalar("SELECT COUNT(*) FROM orders WHERE exchange_order_id IS NOT NULL;"), 4);
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='order.reconciled_v1';"), 4);
    assert.equal(scalar("SELECT COUNT(*) FROM outbox;"), 4);
    assert.equal(scalar("SELECT COUNT(*) FROM recovery_log WHERE incident='reconcile.complete';"), 1);
    // fixed-id cursor: one row, marked COMPLETE, no table growth
    assert.equal(scalar("SELECT COUNT(*) FROM health_snapshots WHERE id='sweep_reconcile';"), 1);
    assert.equal(sql("SELECT status FROM health_snapshots WHERE id='sweep_reconcile';").trim(), "COMPLETE");
  });

  it("an unknown outcome stays non-terminal and is never guessed", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { sweep } = await import("./reconcile.mjs");
    seedIntent({ id: "i1", approval_id: "a1", client_order_id: "c1", status: "SUBMIT_UNKNOWN", at: iso(now - 1000) });

    const out = await sweep(env, { nowMs: now, mode: "DEGRADED", resolve: { intent: () => null } });

    assert.equal(out.remaining, 1);
    assert.equal(out.resolved, 0);
    assert.equal(out.certified, false);
    assert.equal(sql("SELECT status FROM order_intents WHERE id='i1';").trim(), "SUBMIT_UNKNOWN");
    assert.equal(scalar("SELECT COUNT(*) FROM orders;"), 0);
    assert.equal(scalar("SELECT COUNT(*) FROM recovery_log;"), 0); // no false all-clear
    assert.equal(sql("SELECT status FROM health_snapshots WHERE id='sweep_reconcile';").trim(), "IN_PROGRESS");
  });

  it("inventory B: an order missing exchange_order_id is reconciled once the venue answers", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { sweep } = await import("./reconcile.mjs");
    seedOrder({ client_order_id: "c-missing", at: iso(now - 5000) });

    const out = await sweep(env, {
      nowMs: now,
      mode: "DEGRADED",
      resolve: { order: () => ({ exchange_order_id: "ex-9", status: "ACKED" }) },
    });

    assert.equal(out.swept, 1);
    assert.equal(out.orders_remaining, 0);
    assert.equal(out.remaining, 0);
    assert.equal(sql("SELECT exchange_order_id FROM orders WHERE client_order_id='c-missing';").trim(), "ex-9");
    assert.ok(sql("SELECT last_reconciled_at FROM orders WHERE client_order_id='c-missing';").trim().length > 0);
  });

  it("the default paper resolver resolves nothing (never fabricates exchange truth)", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { sweep, paperResolver } = await import("./reconcile.mjs");
    assert.equal(paperResolver.intent(), null);
    seedIntent({ id: "i1", approval_id: "a1", client_order_id: "c1", status: "SUBMITTED", at: iso(now - 1000) });

    const out = await sweep(env, { nowMs: now, mode: "DEGRADED" });

    assert.equal(out.resolved, 0);
    assert.equal(out.remaining, 1);
    assert.equal(scalar("SELECT COUNT(*) FROM orders;"), 0);
    assert.equal(scalar("SELECT COUNT(*) FROM events;"), 0);
  });
});

describe("E06-T02-S3a idempotency + §6.4 no-resubmit", () => {
  it("re-running the sweep changes nothing and never repeats the incident", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { sweep, readCursor } = await import("./reconcile.mjs");
    seedIntent({ id: "i1", approval_id: "a1", client_order_id: "c1", status: "SUBMITTED", at: iso(now - 1000) });
    const resolve = { intent: () => ({ status: "FILLED", exchange_order_id: "ex-1" }) };

    const first = await sweep(env, { nowMs: now, mode: "DEGRADED", resolve });
    const second = await sweep(env, { nowMs: now + 20_000, mode: "DEGRADED", resolve, cursor: await readCursor(env) });

    assert.equal(first.certified, true);
    assert.equal(second.swept, 0);
    assert.equal(second.resolved, 0);
    assert.equal(second.certified, false);
    assert.equal(second.complete_reported, 1); // already certified for this episode
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='order.reconciled_v1';"), 1);
    assert.equal(scalar("SELECT COUNT(*) FROM outbox;"), 1);
    assert.equal(scalar("SELECT COUNT(*) FROM recovery_log WHERE incident='reconcile.complete';"), 1);
  });

  it("recovery never opens a second intent for a consumed approval (§6.4)", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { sweep, duplicateApprovalIntents } = await import("./reconcile.mjs");
    // pre-existing duplication (the kind the chaos harness asserts must never happen)
    seedIntent({ id: "i1", approval_id: "a1", client_order_id: "c1", status: "SUBMITTED", at: iso(now - 2000) });
    seedIntent({ id: "i2", approval_id: "a1", client_order_id: "c2", status: "SUBMITTED", at: iso(now - 1000) });
    const before = sql("SELECT id FROM order_intents ORDER BY id;").trim();

    const out = await sweep(env, { nowMs: now, mode: "DEGRADED", resolve: { intent: () => ({ status: "FILLED" }) } });

    assert.equal(out.remaining, 0);
    // the sweep resolves; it must never insert an intent row (no resubmit path exists)
    assert.equal(sql("SELECT id FROM order_intents ORDER BY id;").trim(), before);
    assert.equal(scalar("SELECT COUNT(*) FROM order_intents;"), 2);
    const rows = JSON.parse(execSync(`sqlite3 -json ${dbFile} "SELECT approval_id FROM order_intents;"`, { encoding: "utf8" }));
    assert.deepEqual(duplicateApprovalIntents(rows), [{ approval_id: "a1", n: 2 }]);
  });
});

describe("E06-T02-S3a rejoin ordering + fail-closed", () => {
  /** §6.3 setup: fresh heartbeat, a 61s continuous-healthy streak already recorded,
   *  authority handed to primary, and one non-terminal intent to reconcile. */
  async function rejoinEnv({ handoff = true, healthySinceMs = 61_000 } = {}) {
    const env = freshEnv();
    const now = Date.now();
    const { recordHeartbeat, handoffLease } = await import("./health-route.mjs");
    await recordHeartbeat(env, { go_heartbeat_ms: now, stream_lag_ms: 0, redis_reachable: true });
    sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('hs_prev','mode','DEGRADED','{}','${iso(now - 61_000)}');`);
    if (healthySinceMs !== null) {
      sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('healthy_since','healthy_since','HEALTHY','{"at_ms":${now - healthySinceMs}}','${iso(now - healthySinceMs)}');`);
    }
    if (handoff) await handoffLease(env, { holder: HOLDERS.PRIMARY, nowMs: now });
    seedIntent({ id: "i1", approval_id: "a1", client_order_id: "c1", status: "SUBMITTED", at: iso(now - 30_000) });
    return { env, now };
  }

  const jsonRows = (q) => JSON.parse(execSync(`sqlite3 -json ${dbFile} "${q}"`, { encoding: "utf8" }));

  it("a degraded system is not locked out: the 60s healthy streak accumulates across blocked ticks", async () => {
    // Regression (found by the first real drill run): the streak used to be derived from
    // the last non-PRIMARY MODE row — but every gate-blocked tick writes one, so the streak
    // reset to ~0 forever and §6.3 condition 1 could never be met.
    const { env, now } = await rejoinEnv({ healthySinceMs: null }); // no prior streak
    const { runCron } = await import("./index.mjs");
    const { handoffLease, recordHeartbeat } = await import("./health-route.mjs");
    const resolve = { intent: () => ({ status: "FILLED", exchange_order_id: "ex1" }) };
    // Go heartbeats every 5s and the DO renews its lease every 10s; the test keeps
    // both fresh before each tick so a stale-heartbeat lapse never fakes a fallback.
    const refresh = (ms) => Promise.all([
      recordHeartbeat(env, { go_heartbeat_ms: ms, stream_lag_ms: 0, redis_reachable: true }),
      handoffLease(env, { holder: HOLDERS.PRIMARY, nowMs: ms }),
    ]);
    const missing = (tick) => (tick.reasons.find((r) => r.startsWith("rejoin_blocked(")) ?? "");

    const t1 = await runCron(env, { nowMs: now, resolve });
    assert.equal(t1.tick.mode, "DEGRADED");
    assert.match(missing(t1.tick), /go_healthy_60s/);
    assert.equal(t1.rejoin.non_terminal_intents, 0); // reconcile + drain + lease already fine

    await refresh(now + 30_000);
    const t2 = await runCron(env, { nowMs: now + 30_000, resolve });
    assert.equal(t2.tick.mode, "DEGRADED");
    assert.match(missing(t2.tick), /go_healthy_60s/);

    // the streak kept running while blocked → the gate opens at +61s
    await refresh(now + 61_000);
    const t3 = await runCron(env, { nowMs: now + 61_000, resolve });
    assert.equal(t3.tick.mode, "PRIMARY");
    assert.ok(jsonRows("SELECT incident FROM recovery_log;").some((r) => r.incident === "health.recovered"));
  });

  it("an unhealthy observation restarts the streak", async () => {
    const { env, now } = await rejoinEnv();
    const { recordHeartbeat, handoffLease } = await import("./health-route.mjs");
    const { runCron } = await import("./index.mjs");
    const resolve = { intent: () => ({ status: "FILLED", exchange_order_id: "ex1" }) };

    // Go goes silent → the marker is reset, the >=60s streak we seeded is gone
    await recordHeartbeat(env, { go_heartbeat_ms: now - 30_000, stream_lag_ms: 0, redis_reachable: true });
    const degraded = await runCron(env, { nowMs: now + 61_000, resolve });
    assert.notEqual(degraded.tick.mode, "PRIMARY"); // DEGRADED, or FALLBACK once engaged (§6.2 S1)

    // Go recovers; the DO still holds/renews its authority lease (every 10s), so the
    // only thing that can block return-to-primary is the streak that just restarted.
    await recordHeartbeat(env, { go_heartbeat_ms: now + 61_000, stream_lag_ms: 0, redis_reachable: true });
    await handoffLease(env, { holder: HOLDERS.PRIMARY, nowMs: now + 61_000 });
    const blocked = await runCron(env, { nowMs: now + 62_000, resolve });
    assert.equal(blocked.tick.mode, "DEGRADED");
    assert.match(blocked.tick.reasons.join(";"), /go_healthy_60s/);
  });

  it("PRIMARY is written only after the reconcile sweep certifies (acceptance 2)", async () => {
    const { env, now } = await rejoinEnv();
    const { runCron } = await import("./index.mjs");
    const res = await runCron(env, { nowMs: now, resolve: { intent: () => ({ status: "FILLED", exchange_order_id: "ex1" }) } });

    assert.equal(res.sweep.remaining, 0);
    assert.equal(res.rejoin.non_terminal_intents, 0);
    assert.equal(res.rejoin.lease_ours, true);
    assert.equal(res.tick.mode, "PRIMARY");

    const modeRows = jsonRows("SELECT status, at FROM health_snapshots WHERE component='mode' ORDER BY at;");
    const incidents = jsonRows("SELECT incident, at FROM recovery_log ORDER BY at;");
    const primary = [...modeRows].reverse().find((r) => r.status === "PRIMARY");
    const reconcile = incidents.find((r) => r.incident === "reconcile.complete");
    assert.ok(primary, "no PRIMARY mode row written");
    assert.ok(reconcile, "no reconcile.complete incident written");
    assert.ok(Date.parse(reconcile.at) <= Date.parse(primary.at), "PRIMARY preceded the reconcile incident");
    assert.ok(incidents.some((r) => r.incident === "health.recovered"));
  });

  it("an unreconciled intent keeps the system DEGRADED even when everything else is green", async () => {
    const { env, now } = await rejoinEnv();
    const { runCron } = await import("./index.mjs");
    const res = await runCron(env, { nowMs: now, resolve: { intent: () => null } }); // still unknown

    assert.equal(res.rejoin.non_terminal_intents, 1);
    assert.equal(res.tick.mode, "DEGRADED");
    assert.ok(res.tick.reasons.includes("rejoin_blocked(reconciled)"));
    assert.equal(scalar("SELECT COUNT(*) FROM recovery_log WHERE incident='reconcile.complete';"), 0);
  });

  it("without the lease handoff the rejoin gate stays shut (§6.3 condition 4)", async () => {
    const { env, now } = await rejoinEnv({ handoff: false });
    const { runCron } = await import("./index.mjs");
    const res = await runCron(env, { nowMs: now, resolve: { intent: () => ({ status: "FILLED" }) } });

    assert.equal(res.rejoin.lease_ours, false);
    assert.equal(res.tick.mode, "DEGRADED");
    assert.ok(res.tick.reasons.includes("rejoin_blocked(lease_handoff)"));
  });

  it("a failing sweep/D1 read never looks like all-clear (fails closed)", async () => {
    const { runCron } = await import("./index.mjs");
    const res = await runCron(brokenEnv(), { nowMs: Date.now() });

    assert.ok(res.sweep_error, "expected the sweep error to be surfaced");
    assert.equal(res.rejoin.non_terminal_intents, null); // unknown → the gate cannot open
    assert.equal(res.rejoin.lease_ours, false);
    assert.equal(res.tick.mode, "D1_DOWN");
  });
});