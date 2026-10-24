// health-heartbeat.test.mjs — E06-T02-W0.2: heartbeat ingest + real cron signals
// + rejoin gate. sqlite-backed fake D1, same harness shape as health-api.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql", "migrations/0006_notify_outbox.sql", "migrations/0007_notify_prefs.sql", "migrations/0008_stop_loss.sql", "migrations/0009_slot_cap.sql", "migrations/0010_regime_filter.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

let dbFile = "";
function sql(q) {
  const tmp = join(tmpdir(), `hq-${Date.now()}-${Math.random()}.sql`);
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
      const tmp = join(tmpdir(), `hsel-${Date.now()}-${Math.random()}.sql`);
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
  dbFile = join(tmpdir(), `e06t02-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `init-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  try { execSync(`sqlite3 ${dbFile} < "${tmp}"`); } finally { rmSync(tmp, { force: true }); }
  return { DB: fakeDb(), ENV: "test", ...extra };
}

const app = async () => (await import("./index.mjs")).default;
const post = (a, env, body, headers = {}) =>
  a.fetch(new Request("http://x/api/health:heartbeat", { method: "POST", body: JSON.stringify(body), headers }), env);

describe("E06-T02-W0.2 heartbeat ingest", () => {
  it("upserts a single hb_go row (no table growth)", async () => {
    const env = freshEnv();
    const { recordHeartbeat, readHeartbeat } = await import("./health-route.mjs");
    await recordHeartbeat(env, { go_heartbeat_ms: 1000, stream_lag_ms: 5, redis_reachable: false });
    await recordHeartbeat(env, { go_heartbeat_ms: 2000, stream_lag_ms: 7, redis_reachable: true });
    assert.equal(sql("SELECT COUNT(*) FROM health_snapshots WHERE id='hb_go';").trim(), "1");
    const hb = await readHeartbeat(env);
    assert.equal(hb.go_heartbeat_ms, 2000);
    assert.equal(hb.stream_lag_ms, 7);
    assert.equal(hb.redis_reachable, true);
  });

  it("route ingests the Go payload; opt-in token boundary", async () => {
    const a = await app();
    const open = await post(a, freshEnv(), { go_heartbeat_ms: Date.now(), stream_lag_ms: 0, redis_reachable: true });
    assert.equal(open.status, 200);
    const guarded = freshEnv({ GO_HEARTBEAT_TOKEN: "s3cr3t" });
    assert.equal((await post(a, guarded, { go_heartbeat_ms: Date.now() })).status, 401);
    assert.equal((await post(a, guarded, { go_heartbeat_ms: Date.now() }, { "x-agent-token": "s3cr3t" })).status, 200);
  });

  it("missing heartbeat reads as never-seen, not healthy", async () => {
    const env = freshEnv();
    const { readHeartbeat, assembleSignals } = await import("./health-route.mjs");
    assert.equal((await readHeartbeat(env)).go_heartbeat_ms, 0);
    assert.equal((await assembleSignals(env, Date.now())).go_heartbeat_ms, 0);
  });
});

describe("E06-T02-W0.2 cron signals + rejoin gate", () => {
  it("fresh heartbeat → PRIMARY and no incident", async () => {
    const env = freshEnv();
    const { recordHeartbeat, runTick } = await import("./health-route.mjs");
    const now = Date.now();
    await recordHeartbeat(env, { go_heartbeat_ms: now, stream_lag_ms: 0, redis_reachable: true });
    const next = await runTick(env, { nowMs: now });
    assert.equal(next.mode, "PRIMARY");
    assert.equal(sql("SELECT status FROM health_snapshots WHERE component='mode' ORDER BY rowid DESC LIMIT 1;").trim(), "PRIMARY");
    assert.equal(sql("SELECT COUNT(*) FROM recovery_log;").trim(), "0");
  });

  it("stale heartbeat → DEGRADED + incident (15s rule)", async () => {
    const env = freshEnv();
    const { recordHeartbeat, runTick } = await import("./health-route.mjs");
    const now = Date.now();
    await recordHeartbeat(env, { go_heartbeat_ms: now - 16_000, stream_lag_ms: 0, redis_reachable: true });
    const next = await runTick(env, { nowMs: now });
    assert.equal(next.mode, "DEGRADED");
    assert.ok(next.reasons.some((r) => r.startsWith("go_unhealthy")));
    assert.match(sql("SELECT incident FROM recovery_log;"), /mode:DEGRADED/);
  });

  it("redis_reachable=false → redis DOWN + redis_unreachable (§6.2 S2)", async () => {
    const env = freshEnv();
    const { recordHeartbeat, assembleSignals, runTick } = await import("./health-route.mjs");
    const now = Date.now();
    await recordHeartbeat(env, { go_heartbeat_ms: now, stream_lag_ms: 0, redis_reachable: false });
    assert.equal((await assembleSignals(env, now)).redis_reachable, false);
    const next = await runTick(env, { nowMs: now });
    assert.equal(next.mode, "DEGRADED");
    assert.ok(next.reasons.includes("redis_unreachable"));
    assert.equal(next.components.find((c) => c.component === "redis").status, "DOWN");
    // Go itself is alive: a Redis outage must not read as a Go loss
    assert.equal(next.components.find((c) => c.component === "go").status, "UP");
  });

  it("falls back once the system is already degraded", async () => {
    const env = freshEnv();
    const { recordHeartbeat, assembleSignals } = await import("./health-route.mjs");
    const now = Date.now();
    sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('hs_prev','mode','DEGRADED','{}','${new Date(now - 5000).toISOString()}');`);
    await recordHeartbeat(env, { go_heartbeat_ms: now - 20_000, stream_lag_ms: 0, redis_reachable: true });
    const sig = await assembleSignals(env, now);
    assert.equal(sig.fallback_active, true);
    const { evaluate } = await import("./health.mjs");
    assert.equal(evaluate(sig).mode, "FALLBACK");
  });

  it("return to PRIMARY needs the §6.3 gate (reconcile pre-PRIMARY)", async () => {
    const env = freshEnv();
    const { recordHeartbeat, runTick } = await import("./health-route.mjs");
    const now = Date.now();
    await recordHeartbeat(env, { go_heartbeat_ms: now, stream_lag_ms: 0, redis_reachable: true });
    sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('hs_prev','mode','DEGRADED','{}','${new Date(now - 61_000).toISOString()}');`);

    // unknown rejoin inputs → the gate stays closed
    const blocked = await runTick(env, { nowMs: now });
    assert.equal(blocked.mode, "DEGRADED");
    assert.ok(blocked.reasons.some((r) => r.startsWith("rejoin_blocked(")));
    assert.match(sql("SELECT action FROM recovery_log;"), /rejoin_blocked/);

    // reconciled + drained + lease handoff → PRIMARY + health.recovered
    const later = now + 61_000;
    await recordHeartbeat(env, { go_heartbeat_ms: later, stream_lag_ms: 0, redis_reachable: true });
    const released = await runTick(env, { nowMs: later, rejoin: { non_terminal_intents: 0, fallback_inflight: 0, lease_ours: true } });
    assert.equal(released.mode, "PRIMARY");
    assert.match(sql("SELECT incident FROM recovery_log;"), /health.recovered/);
  });
});
