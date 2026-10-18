// platform-snapshot.test.mjs — per-turn platform context for advisory chat.
// Acceptance: (1) seeded state renders counts + one-liners + the advisory
// guard; (2) empty D1 renders labelled absence, never fabricated rows;
// (3) a read failure degrades to the unavailable line, never a throw.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ageSec, ageLabel, platformSnapshot, fillCount, ADVISORY_GUARD, SNAPSHOT_LIMIT } from "./platform-snapshot.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
let dbFile;
function sql(q) {
  const tmp = join(tmpdir(), `psq-${Date.now()}-${Math.random()}.sql`);
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
    async all() {
      const tmp = join(tmpdir(), `pss-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
  });
  return { prepare: prep };
}
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
function initDb() {
  dbFile = join(tmpdir(), `pst-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `psi-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
}


function seededEnv() {
  initDb();
  sql(`INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) VALUES('w1','BTCUSDT','LONG','{}','{}','ACTIVE',1,'t','${iso(NOW - 3600_000)}','${iso(NOW - 120_000)}');`);
  sql(`INSERT INTO signals(id,watch_id,kind,payload_json,source,at) VALUES('s1','w1','MTF','{}','go_watcher','${iso(NOW - 60_000)}');`);
  sql(`INSERT INTO approvals(id,watch_id,analysis_id,decision,approver,expires_at,at) VALUES('ap1','w1','an1','approve','trader:x','${iso(NOW + 600_000)}','${iso(NOW - 30_000)}');`);
  sql(`INSERT INTO order_intents(id,watch_id,approval_id,side,qty,leverage,client_order_id,status,at) VALUES('i1','w1','ap1','BUY','0.1',5,'co1','INTENT','${iso(NOW - 10_000)}');`);
  sql(`INSERT INTO positions(symbol,size,entry_px,leverage,updated_at) VALUES('BTCUSDT','0.1','67000',5,'${iso(NOW - 5_000)}');`);
  sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('hs1','mode','PRIMARY','{"reasons":[]}','${iso(NOW - 2_000)}');`);
  sql(`INSERT INTO recovery_log(id,incident,action,actor,at) VALUES('r1','health.recovered','none','system','${iso(NOW - 90_000)}');`);
  sql(`INSERT INTO orders(client_order_id,exchange_order_id,status,fills_json,last_reconciled_at,at) VALUES('co1','ex9','FILLED','[{"qty":"0.1"}]','${iso(NOW - 8_000)}','${iso(NOW - 10_000)}');`);
  sql(`INSERT INTO strategy_configs(version,config_json,activated_by,at) VALUES('v2-test','{"max_leverage":3}','system-seed','${iso(NOW - 48 * 3600_000)}');`);
  sql(`INSERT INTO strategy_drafts(id,strategy_id,version,prompt,code,model,status,created_by,created_at) VALUES('dr1','sma-cross','0.1.0','p','package x','qwen','generated','trader','${iso(NOW - 600_000)}');`);
  return { DB: fakeDb() };
}
function emptyEnv() { initDb(); return { DB: fakeDb() }; }

describe("platform-snapshot — ages", () => {
  it("ageSec/ageLabel label staleness compactly", () => {
    assert.equal(ageLabel(iso(NOW - 5_000), NOW), "5s ago");
    assert.equal(ageLabel(iso(NOW - 180_000), NOW), "3m ago");
    assert.equal(ageLabel(iso(NOW - 7_200_000), NOW), "2h ago");
    assert.equal(ageLabel("not-a-date", NOW), "n/a");
    assert.equal(ageSec(null, NOW), null);
  });
  it("fillCount tolerates absent/malformed fills_json", () => {
    assert.equal(fillCount('[{"qty":"1"},{"qty":"2"}]'), 2);
    assert.equal(fillCount("not-json"), 0);
    assert.equal(fillCount(null), 0);
  });
});

describe("platform-snapshot — render", () => {
  it("a seeded platform renders counts + one-liners + the advisory guard", async () => {
    const text = await platformSnapshot(seededEnv(), { nowMs: NOW });
    assert.match(text, /mode: PRIMARY/);
    assert.match(text, /watches: ACTIVE=1/);
    assert.match(text, /watch: BTCUSDT LONG ACTIVE/);
    assert.match(text, /signal: MTF/);
    assert.match(text, /1 pending grant/);
    assert.match(text, /pending: ap1/);
    assert.match(text, /1 open/);
    assert.match(text, /open-intent: BUY 0\.1 INTENT/);
    assert.match(text, /order: co1 FILLED fills=1/);
    assert.match(text, /strategy: v2-test by=system-seed config=\{"max_leverage":3\}/);
    assert.match(text, /draft: dr1 sma-cross@0\.1\.0 generated/);
    assert.match(text, /position: BTCUSDT size=0\.1/);
    assert.match(text, /incident: health.recovered/);
    assert.ok(text.includes(ADVISORY_GUARD));
  });
  it("an empty D1 renders labelled absence, never fabricated rows", async () => {
    const text = await platformSnapshot(emptyEnv(), { nowMs: NOW });
    assert.match(text, /mode: unavailable/);
    assert.match(text, /watches: none/);
    assert.match(text, /positions: none/);
    assert.ok(!text.includes("watch: "));
    assert.ok(!text.includes("position: "));
  });
  it("a dead DB degrades to labelled absence, never a throw", async () => {
    const text = await platformSnapshot({ DB: { prepare: () => { throw new Error("d1 down"); } } });
    assert.match(text, /mode: unavailable/);
    assert.match(text, /watches: none/);
    assert.ok(text.includes(ADVISORY_GUARD));
  });
  it("no DB at all is the same degradation", async () => {
    const text = await platformSnapshot({});
    assert.match(text, /mode: unavailable/);
    assert.match(text, /positions: none/);
  });
  it("respects the per-domain limit and stays compact", async () => {
    assert.ok(SNAPSHOT_LIMIT <= 5);
    const text = await platformSnapshot(seededEnv(), { nowMs: NOW });
    assert.ok(text.split("\n").length <= 40);
  });
});
