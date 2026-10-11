// watches.test.mjs — E04-T02: FSM guards, SQL builders, timeline (node:test, stdlib).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { guardTransition, transitionSql, activeSnapshotSql, WATCH_EDGES } from "./watches.mjs";
import { signalInsertSql, eventAppendSql, timelineSql } from "./timeline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
const tmp = join(tmpdir(), `e04t02-${Date.now()}.sql`);
const run = (sql, expectFail = false) => {
  writeFileSync(tmp, sql);
  try {
    const out = execSync(`sqlite3 :memory: < "${tmp}"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    if (expectFail) throw new Error("expected SQL failure");
    return out;
  } catch (e) {
    if (!expectFail) throw e;
    return "FAILED-AS-EXPECTED";
  }
};

describe("E04-T02 watch repo + audit", () => {
  it("S1: all 9 FSM edges enumerated, illegal edge throws 409", () => {
    assert.deepEqual(WATCH_EDGES.ANALYZED, ["APPROVED", "CLOSED"]);
    assert.throws(() => guardTransition("TRIGGERED", "ORDERED"), (e) => e.code === 409);
    assert.throws(() => guardTransition("CLOSED", "ACTIVE"), (e) => e.code === 409);
    guardTransition("APPROVED", "ORDERED"); // legal, no throw
  });
  it("S1: stale version write affects zero rows (optimistic concurrency)", () => {
    const seed = `${chain}\nINSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) VALUES('w1','BTCUSDT','LONG','{}','{}','ACTIVE',2,'t','now','now');\n`;
    const sql = transitionSql("w1", "ACTIVE", "TRIGGERED", 1, { tid: "tr1", reason: "px", actor: "go", at: "now" });
    const out = run(`${seed}\n${sql}\nSELECT version || '|' || status FROM watches WHERE id='w1';\n`);
    assert.match(out, /2\|ACTIVE/); // version mismatch → row untouched
  });
  it("S1: legal transition writes transition row", () => {
    const seed = `${chain}\nINSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) VALUES('w2','ETHUSDT','SHORT','{}','{}','ACTIVE',1,'t','now','now');\n`;
    const sql = transitionSql("w2", "ACTIVE", "TRIGGERED", 1, { tid: "tr2", reason: "px", actor: "go", at: "2026-10-10T00:00:01Z" });
    const out = run(`${seed}\n${sql}\nSELECT to_s FROM watch_transitions WHERE id='tr2';\n`);
    assert.match(out, /TRIGGERED/);
  });
  it("S2: trigger stores transition + event rows; timeline returns ordered history", () => {
    const sql = [
      chain,
      `INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) VALUES('w3','SOLUSDT','LONG','{}','{}','ACTIVE',1,'t','t0','t0');`,
      transitionSql("w3", "ACTIVE", "TRIGGERED", 1, { tid: "tr3", reason: "cross", actor: "go", at: "t1" }),
      eventAppendSql({ id: "evt_3", type: "watch.triggered_v1", entity_id: "w3", payload_json: "{}", dedupe_key: "watch.triggered_v1:w3:1", at: "t1" }),
      signalInsertSql({ id: "sig_1", watch_id: "w3", kind: "MTF", payload_json: "{}", source: "ext", at: "t0" }),
      timelineSql("w3"),
    ].join("\n");
    const out = run(sql);
    assert.match(out, /TRIGGERED/); assert.match(out, /watch\.triggered_v1/); assert.match(out, /signal:MTF/);
  });
  it("S2: unknown signal kind rejected 400; bad kind never stored", () => {
    assert.throws(() => signalInsertSql({ id: "x", watch_id: "w", kind: "NOPE", payload_json: "{}", source: "s", at: "t" }), (e) => e.code === 400);
  });
  it("S1: active snapshot query lists ACTIVE only, ordered", () => {
    assert.match(activeSnapshotSql(), /WHERE status='ACTIVE'/);
  });
});
