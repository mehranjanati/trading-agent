// execution.test.mjs — E09-T01: submit path, idempotency, reconcile, positions.
// node:test + the repo's sqlite-backed fake D1. The exchange is the paper
// simulator (D-06); `loseAck` reproduces the docs/05 §5.6 ack-lost sequence.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
let dbFile;
function sql(q) {
  const tmp = join(tmpdir(), `e09q-${Date.now()}-${Math.random()}.sql`);
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
      const tmp = join(tmpdir(), `e09s-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
  });
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}

const NOW = 1_800_000_000_000;
const LIMITS = {
  max_leverage: 5, max_notional_usd: "1000", max_exposure_usd: "5000",
  allowlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], stale_s_seconds: 5,
};
/** A DB ready to submit: ACTIVE watch, granted approval, held lease, fresh price. */
function readyEnv({ nowMs = NOW, lease = true, price = "100", priceAgeMs = 1000, approvalExpiresMs = 600_000, exchange = null } = {}) {
  dbFile = join(tmpdir(), `e09-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `e09i-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
  const iso = (ms) => new Date(ms).toISOString();
  sql(`INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) VALUES('w_1','BTCUSDT','LONG','{}','{}','ACTIVE',1,'t','${iso(nowMs)}','${iso(nowMs)}');`);
  sql(`INSERT INTO approvals(id,watch_id,analysis_id,decision,reason,approver,single_use,used_at,expires_at,at) VALUES('ap_1','w_1','an_1','approve',NULL,'trader:meh',1,NULL,'${iso(nowMs + approvalExpiresMs)}','${iso(nowMs)}');`);
  if (lease) {
    sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('lease_authority','lease_authority','primary','${JSON.stringify({ holder: "primary", epoch: 1, expires_ms: nowMs + 3_600_000 })}','${iso(nowMs)}');`);
  }
  if (price !== null) {
    const st = { symbols: 1, quotes: [{ symbol: "BTCUSDT", price }], last_poll_ms: nowMs - priceAgeMs, inflight: 0, rounds: 1 };
    sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('poll_quotes','fallback_poll','IDLE','${JSON.stringify(st)}','${iso(nowMs)}');`);
  }
  return { DB: fakeDb(), ENV: "test", EXCHANGE: exchange ?? undefined };
}
const deps = (env, extra = {}) => ({
  approval_id: "ap_1", side: "BUY", qty: "1", leverage: 5,
  exchange: env.EXCHANGE ?? undefined, lease: undefined, kill: { engaged: false },
  limits: LIMITS, limits_version: "v1-paper", nowMs: NOW, ...extra,
});

let submitIntent, createPaperExchange, exchangeResolver, reconcile;
before(async () => {
  ({ submitIntent } = await import("./execution.mjs"));
  ({ createPaperExchange, exchangeResolver } = await import("./exchange.mjs"));
  ({ sweep: reconcile } = await import("./reconcile.mjs"));
});
const scalar = (q) => sql(q).trim();
describe("E09-T01-S1 submit path — kill → fence → risk → consume → intent", () => {
  it("ACCEPTANCE: no lease → fenced 503 and NOTHING is written", async () => {
    const env = readyEnv({ lease: false });
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, { ...deps(env), exchange: createPaperExchange({ fill: true }), lease: await readLease(env) });
    assert.equal(out.ok, false);
    assert.equal(out.code, "DEGRADED");
    assert.equal(out.status, 503);
    assert.equal(scalar("SELECT COUNT(*) FROM order_intents;"), "0");
    assert.equal(scalar("SELECT used_at FROM approvals WHERE id='ap_1';"), "");
  });

  it("kill engaged → R-KILL 422, before any write", async () => {
    const env = readyEnv();
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, {
      ...deps(env), exchange: createPaperExchange({ fill: true }),
      lease: await readLease(env), kill: { engaged: true, actor: "operator", reason: "drill" },
    });
    assert.equal(out.risk_code, "R-KILL");
    assert.equal(out.status, 422);
    assert.equal(scalar("SELECT COUNT(*) FROM order_intents;"), "0");
  });

  it("risk reject (over-leverage) → R-LEV 422 and the approval is NOT burned", async () => {
    const env = readyEnv();
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, {
      ...deps(env, { leverage: 99 }), exchange: createPaperExchange({ fill: true }),
      lease: await readLease(env),
    });
    assert.equal(out.risk_code, "R-LEV");
    assert.deepEqual(out.detail, { limit: 5, asked: 99 });
    assert.equal(scalar("SELECT COUNT(*) FROM order_intents;"), "0");
    assert.equal(scalar("SELECT used_at FROM approvals WHERE id='ap_1';"), "");
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='risk.rejected_v1';"), "1");
  });

  it("stale price → R-STALE 422 (our own data, never the caller's)", async () => {
    const env = readyEnv({ priceAgeMs: 60_000 });
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, {
      ...deps(env), exchange: createPaperExchange({ fill: true }), lease: await readLease(env),
    });
    assert.equal(out.risk_code, "R-STALE");
  });
  it("no market data at all → fails closed (never invents a price)", async () => {
    const env = readyEnv({ price: null });
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, {
      ...deps(env), exchange: createPaperExchange({ fill: true }), lease: await readLease(env),
    });
    assert.equal(out.ok, false);
    assert.ok(["R-NOT", "R-STALE"].includes(out.risk_code), out.risk_code);
  });
});

describe("E09-T01-S1/S2 happy path, ack-loss reconcile, idempotency", () => {
  it("happy path FILLED: intent → orders → consumed approval → position snapshot", async () => {
    const env = readyEnv({ exchange: createPaperExchange({ fill: true }) });
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, { ...deps(env, { exchange: env.EXCHANGE }), lease: await readLease(env) });
    assert.equal(out.status, 201);
    assert.equal(scalar("SELECT status FROM order_intents;"), "FILLED");
    assert.equal(scalar("SELECT status FROM orders;"), "FILLED");
    assert.equal(scalar("SELECT used_at IS NOT NULL FROM approvals WHERE id='ap_1';"), "1");
    const pos = JSON.parse(sql(".mode json\nSELECT * FROM positions WHERE symbol='BTCUSDT';"));
    assert.equal(pos[0].size, "1");
    assert.equal(pos[0].entry_px, "100");
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='position.snapshot_v1';"), "1");
  });

  it("ACCEPTANCE: lost ack → SUBMIT_UNKNOWN → reconcile by client id → exactly ONE order", async () => {
    const ex = createPaperExchange({ loseAck: true, fill: true });
    const env = readyEnv({ exchange: ex });
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, { ...deps(env, { exchange: ex }), lease: await readLease(env) });
    assert.equal(out.status, 201);
    assert.equal(scalar("SELECT status FROM order_intents;"), "SUBMIT_UNKNOWN");
    assert.equal(scalar("SELECT COUNT(*) FROM recovery_log WHERE incident='order.submit_unknown';"), "1");
    assert.equal(scalar("SELECT COUNT(*) FROM orders;"), "1");

    const r1 = await reconcile(env, { nowMs: NOW + 2000, mode: "DEGRADED", resolve: exchangeResolver(ex) });
    assert.equal(scalar("SELECT status FROM order_intents;"), "FILLED");
    assert.equal(scalar("SELECT COUNT(*) FROM orders WHERE exchange_order_id IS NOT NULL;"), "1");
    assert.ok(r1.resolved >= 1);
    const r2 = await reconcile(env, { nowMs: NOW + 4000, mode: "DEGRADED", resolve: exchangeResolver(ex) });
    assert.equal(scalar("SELECT COUNT(*) FROM order_intents;"), "1");
    assert.equal(scalar("SELECT COUNT(*) FROM orders;"), "1");
    assert.equal(r2.resolved, 0);
  });

  it("duplicate submit → 409: one exchange order per approval", async () => {
    const ex = createPaperExchange({ fill: true });
    const env = readyEnv({ exchange: ex });
    const { readLease } = await import("./health-route.mjs");
    const first = await submitIntent(env, { ...deps(env, { exchange: ex }), lease: await readLease(env) });
    assert.equal(first.status, 201);
    const second = await submitIntent(env, { ...deps(env, { exchange: ex }), lease: await readLease(env) });
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.equal(second.code, "CONFLICT");
    assert.equal(scalar("SELECT COUNT(*) FROM order_intents;"), "1");
    assert.equal(scalar("SELECT COUNT(*) FROM orders;"), "1");
  });

  it("partial fill persists as ACKED and stays live (never counted reconciled)", async () => {
    const ex = createPaperExchange({ fill: false });
    const env = readyEnv({ exchange: ex });
    const { readLease } = await import("./health-route.mjs");
    const out = await submitIntent(env, { ...deps(env, { exchange: ex }), lease: await readLease(env) });
    assert.equal(out.status, 201);
    assert.equal(scalar("SELECT status FROM order_intents;"), "ACKED");
    const r = await reconcile(env, { nowMs: NOW + 2000, mode: "DEGRADED", resolve: exchangeResolver(ex) });
    assert.equal(r.progressed, 1);
    assert.equal(r.resolved, 0);
    assert.equal(r.remaining, 1);
    assert.equal(scalar("SELECT status FROM order_intents;"), "ACKED");
  });
});
