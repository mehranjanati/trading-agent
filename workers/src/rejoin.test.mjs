// rejoin.test.mjs — E06-T02-S3b: lease handoff + fencing on the rejoin path.
// Part 1 proves the §6.3 sequence against the pure state machine (no DB, do.test.mjs
// pattern); part 2 drives the same rules through the D1 authority row and the cron.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthority, holdsAuthority, HOLDERS, TTL_MS } from "./lease.mjs";
import { canReturnToPrimary, TH } from "./health.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql", "migrations/0006_notify_outbox.sql", "migrations/0007_notify_prefs.sql", "migrations/0008_stop_loss.sql", "migrations/0009_slot_cap.sql", "migrations/0010_regime_filter.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

let dbFile = "";
function sql(q) {
  const tmp = join(tmpdir(), `jq-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try { return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }); }
  finally { rmSync(tmp, { force: true }); }
}
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
      const tmp = join(tmpdir(), `jsel-${Date.now()}-${Math.random()}.sql`);
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
function freshEnv(extra = {}) {
  dbFile = join(tmpdir(), `e06t02j-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `jinit-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  try { execSync(`sqlite3 ${dbFile} < "${tmp}"`); } finally { rmSync(tmp, { force: true }); }
  return { DB: fakeDb(), ENV: "test", ...extra };
}
const seedLease = (holder, epoch, expires_ms, at) =>
  sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('lease_authority','lease_authority',` +
    `'${holder}','{"holder":"${holder}","epoch":${epoch},"expires_ms":${expires_ms}}','${at}');`);
const scalars = (q) => execSync(`sqlite3 ${dbFile} "${q}"`, { encoding: "utf8" }).trim();

const mem = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), put: (k, v) => m.set(k, v) };
};

describe("E06-T02-S3b rejoin sequence (module level, no DB)", () => {
  it("fallback holds → drained+reconciled → handoff → primary returns; zombie fenced", () => {
    const auth = createAuthority(mem());
    const fallback = auth.acquire(HOLDERS.FALLBACK, 1000); // degradation: fallback takes authority
    assert.equal(fallback.ok, true);
    const epochFallback = fallback.epoch;

    // §6.3 conditions 2+3 hold, condition 4 does not → the gate stays shut
    const before = canReturnToPrimary({
      healthy_contig_ms: TH.RECOVER_CONTIG_MS,
      non_terminal_intents: 0,
      fallback_inflight: 0,
      lease_ours: holdsAuthority(auth.load(), HOLDERS.PRIMARY, 2000),
    });
    assert.equal(before.ok, false);
    assert.deepEqual(before.missing, ["lease_handoff"]);

    // §6.3 step 4: the fallback releases, the primary re-acquires with a bumped epoch
    assert.equal(auth.release(HOLDERS.FALLBACK, epochFallback).ok, true);
    const primary = auth.acquire(HOLDERS.PRIMARY, 3000);
    assert.equal(primary.ok, true);
    assert.ok(primary.epoch > epochFallback, "epoch must increase monotonically");

    // a stale submit / renewal carrying the old epoch is fenced (lease.fenced)
    const stale = auth.verify(HOLDERS.FALLBACK, epochFallback, 3001);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "fenced");
    assert.equal(auth.renew(HOLDERS.FALLBACK, epochFallback, 3002).reason, "stale-epoch");

    // condition 4 now holds → the gate opens → mode PRIMARY + health.recovered
    const after = canReturnToPrimary({
      healthy_contig_ms: TH.RECOVER_CONTIG_MS + 1000,
      non_terminal_intents: 0,
      fallback_inflight: 0,
      lease_ours: holdsAuthority(auth.load(), HOLDERS.PRIMARY, 3003),
    });
    assert.equal(after.ok, true);
    assert.deepEqual(after.missing, []);
  });

  it("an expired lease is never 'ours' (TTL 30s, §6.3 fails closed)", () => {
    const auth = createAuthority(mem());
    const r = auth.acquire(HOLDERS.PRIMARY, 0);
    assert.equal(r.expires_ms, TTL_MS);
    assert.equal(holdsAuthority(auth.load(), HOLDERS.PRIMARY, TTL_MS - 1), true);
    assert.equal(holdsAuthority(auth.load(), HOLDERS.PRIMARY, TTL_MS), false);
    assert.equal(canReturnToPrimary({
      healthy_contig_ms: TH.RECOVER_CONTIG_MS, non_terminal_intents: 0,
      fallback_inflight: 0, lease_ours: holdsAuthority(auth.load(), HOLDERS.PRIMARY, TTL_MS),
    }).ok, false);
  });
});

describe("E06-T02-S3b authority row (D1) + cron renewal", () => {
  it("handoff bumps the epoch and fences the previous holder", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { handoffLease, readLease, renewLease, verifyLease } = await import("./health-route.mjs");

    const fallback = await handoffLease(env, { holder: HOLDERS.FALLBACK, nowMs: now });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.epoch, 1);
    assert.equal((await readLease(env)).holder, HOLDERS.FALLBACK);

    const primary = await handoffLease(env, { holder: HOLDERS.PRIMARY, nowMs: now + 1000 });
    assert.equal(primary.ok, true);
    assert.equal(primary.epoch, 2); // release + acquire → strictly greater epoch
    assert.equal(scalars("SELECT COUNT(*) FROM health_snapshots WHERE id='lease_authority';"), "1"); // fixed id

    // the zombie fallback can neither renew nor submit with its old epoch
    const renew = await renewLease(env, { holder: HOLDERS.FALLBACK, epoch: 1, nowMs: now + 1500 });
    assert.equal(renew.ok, false);
    assert.equal(renew.reason, "stale-epoch");
    const verify = await verifyLease(env, { holder: HOLDERS.FALLBACK, epoch: 1, nowMs: now + 1600 });
    assert.equal(verify.ok, false);
    assert.equal(verify.reason, "fenced");
    // …while the current holder verifies fine
    assert.equal((await verifyLease(env, { holder: HOLDERS.PRIMARY, epoch: 2, nowMs: now + 1700 })).ok, true);
  });

  it("the cron renews while held, and stops counting the lease as ours once it lapses", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { handoffLease, readLease, recordHeartbeat } = await import("./health-route.mjs");
    const { runCron } = await import("./index.mjs");

    const granted = await handoffLease(env, { holder: HOLDERS.PRIMARY, nowMs: now });
    await recordHeartbeat(env, { go_heartbeat_ms: now, stream_lag_ms: 0, redis_reachable: true });

    const tick1 = await runCron(env, { nowMs: now + 5000 });
    assert.equal(tick1.rejoin.lease_ours, true);
    const renewed = await readLease(env);
    assert.ok(renewed.expires_ms > granted.expires_ms, "the holder renews its own lease");
    assert.equal(renewed.epoch, granted.epoch, "renewal never bumps the epoch");

    // a lease handed over long ago (TTL lapsed) is nobody's
    const stale = freshEnv();
    await handoffLease(stale, { holder: HOLDERS.PRIMARY, nowMs: now - 2 * TTL_MS });
    const tick2 = await runCron(stale, { nowMs: now });
    assert.equal(tick2.rejoin.lease_ours, false);
  });

  it("an expired authority row degrades the system (lease is a health input, §6.1)", async () => {
    const env = freshEnv();
    const now = Date.now();
    const { assembleSignals } = await import("./health-route.mjs");
    const { evaluate } = await import("./health.mjs");
    seedLease(HOLDERS.PRIMARY, 4, now - 1, new Date(now - 40_000).toISOString());
    sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('hb_go','hb_go','ALIVE','{"go_heartbeat_ms":${now},"stream_lag_ms":0,"redis_reachable":true}','${new Date(now).toISOString()}');`);

    const sig = await assembleSignals(env, now);
    assert.equal(sig.lease_holder, HOLDERS.PRIMARY);
    assert.equal(sig.lease_expires_ms, now - 1);
    const next = evaluate(sig);
    assert.equal(next.mode, "DEGRADED");
    assert.ok(next.reasons.includes("lease_expired"));
    assert.equal(next.components.find((c) => c.component === "lease").status, "EXPIRED");
  });

  it("POST /api/lease:handoff is operator-only and records the handoff", async () => {
    const env = freshEnv();
    const app = (await import("./index.mjs")).default;
    const post = (role) => app.fetch(new Request("http://x/api/lease:handoff", {
      method: "POST", headers: { "x-role": role, "content-type": "application/json" },
      body: JSON.stringify({ holder: HOLDERS.PRIMARY }),
    }), env);

    const denied = await post("trader");
    assert.equal(denied.status, 403);
    const allowed = await post("operator");
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).epoch, 1);
    assert.match(scalars("SELECT incident FROM recovery_log;"), /lease\.handoff/);
  });
});
