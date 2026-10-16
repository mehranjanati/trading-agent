// trigger.test.mjs — E03-T01 wiring: the Go trigger loop's edge into D1.
//
// Acceptance frame (the loop must be able to retry safely, and a refusal must
// never become invented data):
//   - an ACTIVE watch at the evaluated version moves ACTIVE→TRIGGERED, records
//     the transition + event + outbox, then gets its advisory analysis run and
//     the TRIGGERED→ANALYZED edge;
//   - a replay (same watch_id+seq) and a stale evaluation are answered 200 with
//     an explicit reason and write NOTHING twice;
//   - a watch that is not ACTIVE is left alone (the loop's view was stale);
//   - an unreachable engine leaves the watch TRIGGERED and writes NO analysis
//     row — no fabrication, the run can be re-asked explicitly;
//   - an INVALIDATED edge never runs an analysis;
//   - the agent token gates the route (it is a service route, not a browser one).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbFile = join(tmpdir(), `trig-${Date.now()}.sqlite`);
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

function sql(q) {
  const tmp = join(tmpdir(), `tq-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try {
    return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" });
  } finally { rmSync(tmp, { force: true }); }
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
      if (!/^\s*(SELECT|WITH)/i.test(this._s)) { sql(this._fill()); return { results: [] }; }
      const tmp = join(tmpdir(), `ts-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
  });
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}
const env = (extra = {}) => ({ DB: fakeDb(), ENV: "test", GO_WATCHER_URL: "https://go.test", ...extra });

let app;
before(async () => {
  const tmp = join(tmpdir(), `tinit-${Date.now()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
  app = (await import("./index.mjs")).default;
});

/** An ACTIVE v2 watch, exactly as the Stalk publish leaves it. */
function seedActive(id, symbol = "BTCUSDT") {
  sql("INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) " +
    `VALUES('${id}','${symbol}','LONG','{"op":">=","price":"100"}','{"op":"<=","price":"50"}','ACTIVE',2,'trader','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');`);
}

function fire(body, headers = {}) {
  return app.fetch(new Request("http://x/api/watches:trigger", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env());
}

const ENGINE_AGG = { bias: "LONG", confidence: 0.31, agree: 1, disagree: 0, flat: 0, errors: 0, n: 1, explanation: "1 verdicts (0 errors): longW=0.62 shortW=0.00 flat=0" };
function stubEngine({ analyzeStatus = 200 } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/strategies/registry")) return json({ count: 1, strategies: [{ id: "sma-cross", version: "0.1.0" }] });
    if (analyzeStatus !== 200) return json({ code: "DATA_UNAVAILABLE" }, analyzeStatus);
    return json({
      id: "an_engine_1", symbol: "BTCUSDT", at: "2026-10-16T00:00:00Z", aggregate: ENGINE_AGG,
      verdicts: [{ strategy_id: "sma-cross", strategy_version: "0.1.0", timeframe: "15m", data_source: "toobit-rest", result: { status: "SIGNAL", decision: { bias: "LONG", confidence: 0.62 }, diagnostics: { reason: "cross" } } }],
      suggest_zones: { timeframe: "15m", source: "toobit-rest", bars: 120, last: "100", atr: "1", trigger_long: "100", inval_long: "99", trigger_short: "98", inval_short: "101" },
    });
  };
}
const clearStub = () => { delete globalThis.fetch; };

const FIRE = { watch_id: "w1", kind: "TRIGGERED", px: "100.5", prev_px: "99.9", seq: 1, watch_version: 2, ts: "2026-10-16T12:00:00Z" };

describe("E03-T01 trigger edge — ACTIVE → TRIGGERED → ANALYZED", () => {
  it("moves the watch, records the edge, then stores the live analysis", async () => {
    seedActive("w1");
    try {
      stubEngine();
      const res = await fire(FIRE);
      assert.equal(res.status, 201);
      const j = await res.json();
      assert.equal(j.status, "ANALYZED");
      assert.equal(j.bias, "LONG");
      assert.match(j.analysis_id, /^an_/);                 // our stored run row
      assert.equal(j.engine.analyze_id, "an_engine_1");    // the engine's own run
      assert.deepEqual(j.engine.data_sources, ["toobit-rest"]);
      // The watch moved through both edges, each with its audit row.
      assert.equal(sql("SELECT status || '|' || version FROM watches WHERE id='w1';").trim(), "ANALYZED|4");
      const trans = sql("SELECT from_s || '->' || to_s FROM watch_transitions WHERE watch_id='w1' ORDER BY rowid;").trim().split("\n");
      assert.deepEqual(trans, ["ACTIVE->TRIGGERED", "TRIGGERED->ANALYZED"]);
      assert.equal(sql("SELECT type FROM events WHERE entity_id='w1';").trim(), "watch.triggered_v1");
      assert.match(sql("SELECT dedupe_key FROM events WHERE entity_id='w1';"), /watch\.triggered_v1:w1:1/);
      assert.match(sql("SELECT payload_json FROM events WHERE entity_id='w1';"), /100\.5/);
      assert.equal(sql("SELECT COUNT(*) FROM outbox WHERE payload_json LIKE '%w1%';").trim(), "1");
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs WHERE watch_id='w1';").trim(), "1");
      assert.match(sql("SELECT model FROM analysis_runs WHERE watch_id='w1';"), /wasm-engine/);
    } finally { clearStub(); }
  });

  it("a replay of the same edge is a no-op, not a second event", async () => {
    seedActive("w2");
    try {
      stubEngine();
      const first = await fire({ ...FIRE, watch_id: "w2" });
      assert.equal(first.status, 201);
      const replay = await fire({ ...FIRE, watch_id: "w2" });
      assert.equal(replay.status, 200);
      const j = await replay.json();
      assert.equal(j.duplicate, true);
      assert.equal(sql("SELECT COUNT(*) FROM events WHERE entity_id='w2';").trim(), "1");
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs WHERE watch_id='w2';").trim(), "1");
      assert.equal(sql("SELECT COUNT(*) FROM watch_transitions WHERE watch_id='w2';").trim(), "2");
    } finally { clearStub(); }
  });
});

describe("E03-T01 trigger edge — the loop's view can be stale", () => {
  it("a stale evaluation version is ignored (nothing written)", async () => {
    seedActive("w3");
    try {
      stubEngine();
      const res = await fire({ ...FIRE, watch_id: "w3", watch_version: 1 }); // loop read v1, D1 is at v2
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.match(j.ignored, /stale evaluation/);
      assert.equal(sql("SELECT status FROM watches WHERE id='w3';").trim(), "ACTIVE");
      assert.equal(sql("SELECT COUNT(*) FROM events WHERE entity_id='w3';").trim(), "0");
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs WHERE watch_id='w3';").trim(), "0");
    } finally { clearStub(); }
  });

  it("a watch that is no longer ACTIVE is left alone", async () => {
    // An operator closed it (or it expired) while the loop still held it.
    sql("INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) " +
      "VALUES('w4','BTCUSDT','LONG','{\"op\":\">=\",\"price\":\"100\"}','{}','CLOSED',5,'trader','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');");
    try {
      stubEngine();
      const res = await fire({ ...FIRE, watch_id: "w4" });
      assert.equal(res.status, 200);
      assert.match((await res.json()).ignored, /not ACTIVE/);
      assert.equal(sql("SELECT status || version FROM watches WHERE id='w4';").trim(), "CLOSED5");
      assert.equal(sql("SELECT COUNT(*) FROM events WHERE entity_id='w4';").trim(), "0");
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs WHERE watch_id='w4';").trim(), "0");
    } finally { clearStub(); }
  });
});

describe("E03-T01 trigger edge — failure paths never fabricate", () => {
  it("an unreachable engine leaves the watch TRIGGERED with no analysis row", async () => {
    seedActive("w5");
    try {
      stubEngine({ analyzeStatus: 502 });
      const res = await fire({ ...FIRE, watch_id: "w5" });
      assert.equal(res.status, 202);
      const j = await res.json();
      assert.equal(j.status, "TRIGGERED");
      assert.match(j.analysis_degraded, /analysis engine unavailable/);
      assert.equal(sql("SELECT status || '|' || version FROM watches WHERE id='w5';").trim(), "TRIGGERED|3");
      // The edge IS recorded (the trigger really happened) — the RUN is not.
      assert.equal(sql("SELECT COUNT(*) FROM events WHERE entity_id='w5';").trim(), "1");
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs WHERE watch_id='w5';").trim(), "0");
      // And it can be re-asked explicitly once the engine is back.
      stubEngine();
      const run = await app.fetch(new Request("http://x/api/analysis:runs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ watch_id: "w5" }),
      }), env());
      assert.equal(run.status, 201);
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs WHERE watch_id='w5';").trim(), "1");
    } finally { clearStub(); }
  });

  it("an INVALIDATED edge records the invalidation and never runs an analysis", async () => {
    seedActive("w6");
    try {
      stubEngine();
      const res = await fire({ ...FIRE, watch_id: "w6", kind: "INVALIDATED", px: "49" });
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.equal(j.status, "INVALIDATED");
      assert.equal(sql("SELECT status || '|' || version FROM watches WHERE id='w6';").trim(), "INVALIDATED|3");
      assert.equal(sql("SELECT type FROM events WHERE entity_id='w6';").trim(), "watch.invalidated_v1");
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs WHERE watch_id='w6';").trim(), "0");
    } finally { clearStub(); }
  });

  it("rejects a malformed edge before touching anything", async () => {
    seedActive("w7");
    const eventsBefore = Number(sql("SELECT COUNT(*) FROM events;").trim());
    try {
      stubEngine();
      const badPx = await fire({ ...FIRE, watch_id: "w7", px: 100.5 });        // float price
      assert.equal(badPx.status, 400);
      const badSeq = await fire({ ...FIRE, watch_id: "w7", seq: 0 });          // no dedupe identity
      assert.equal(badSeq.status, 400);
      const badKind = await fire({ ...FIRE, watch_id: "w7", kind: "FIRE" });
      assert.equal(badKind.status, 400);
      const missing = await fire({ ...FIRE, watch_id: "nope" });
      assert.equal(missing.status, 404);
      assert.equal(sql("SELECT status FROM watches WHERE id='w7';").trim(), "ACTIVE");
      assert.equal(Number(sql("SELECT COUNT(*) FROM events;").trim()), eventsBefore);
    } finally { clearStub(); }
  });

  it("the agent token gates the route when configured", async () => {
    seedActive("w8");
    const e = { ...env(), GO_AGENT_TOKEN: "s3cr3t" };
    const noToken = await app.fetch(new Request("http://x/api/watches:trigger", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...FIRE, watch_id: "w8" }),
    }), e);
    assert.equal(noToken.status, 401);
    const wrong = await app.fetch(new Request("http://x/api/watches:trigger", {
      method: "POST", headers: { "content-type": "application/json", "x-agent-token": "nope" }, body: JSON.stringify({ ...FIRE, watch_id: "w8" }),
    }), e);
    assert.equal(wrong.status, 401);
    assert.equal(sql("SELECT status FROM watches WHERE id='w8';").trim(), "ACTIVE");
  });
});

