// routes.test.mjs — E05-T01-S3: contract tests (node:test, stdlib).
// Fake D1: sqlite-backed via system sqlite3 CLI (same pattern as migrate-check).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbFile = join(tmpdir(), `e05t01-${Date.now()}.sqlite`);
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

function sql(q) {
  const tmp = join(tmpdir(), `q-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try {
    return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" });
  } finally { rmSync(tmp, { force: true }); }
}
// Minimal D1-compatible fake: prepare().bind().all()/run() + batch().
function fakeDb() {
  const prep = (stmt) => ({
    _s: stmt, _a: [],
    bind(...a) { this._a = a; return this; },
    _fill() {
      let s = this._s, i = 0;
      s = s.replaceAll("?", () => {
        const v = this._a[i++];
        if (v === null || v === undefined) return "NULL";
        return `'${String(v).replaceAll("'", "''")}'`;
      });
      return s;
    },
    async all() {
      const out = sql(this._fill());
      return { results: [] };
    },
    async run() { sql(this._fill()); return {}; },
  });
  // all() needs row parsing: use JSON mode for SELECTs.
  const prep2 = (stmt) => {
    const p = prep(stmt);
    const origAll = p.all.bind(p);
    p.all = async () => {
      if (!/^\s*SELECT/i.test(stmt)) { await origAll(); return { results: [] }; }
      const tmp = join(tmpdir(), `sel-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${p._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        const rows = raw ? JSON.parse(raw) : [];
        return { results: rows };
      } finally { rmSync(tmp, { force: true }); }
    };
    return p;
  };
  return { prepare: prep2, async batch(list) { for (const s of list) await s.run(); } };
}

let app;
before(async () => {
  const tmp = join(tmpdir(), `init-${Date.now()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
  app = (await import("./index.mjs")).default;
});
const env = (extra = {}) => ({ DB: fakeDb(), ENV: "test", ...extra });
const req = (method, path, body, headers = {}) =>
  new Request(`http://x${path}`, {
    method, headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("E05-T01 control API contracts", () => {
  it("S3: validation envelope {code,message,trace_id,retryable} on bad body", async () => {
    const r = await app.fetch(req("POST", "/api/watches", { symbol: "nope" }), env());
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, "VALIDATION");
    assert.ok(j.trace_id); assert.equal(j.retryable, false);
  });
  it("S3: RBAC — operator cannot grant approvals (403+trace_id)", async () => {
    const r = await app.fetch(req("POST", "/api/approvals",
      { watch_id: "w", analysis_id: "a", decision: "approve" }, { "x-role": "operator" }), env());
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.code, "FORBIDDEN"); assert.ok(j.trace_id);
  });
  it("S1: create watch 201 + idempotent replay returns same ID", async () => {
    const b = { symbol: "BTCUSDT", direction: "LONG", trigger: { op: "cross_above", price: "67000" }, invalidation: { op: "<=", price: "65000" } };
    const h = { "Idempotency-Key": "k-123" };
    const r1 = await app.fetch(req("POST", "/api/watches", b, h), env());
    assert.equal(r1.status, 201);
    const j1 = await r1.json();
    assert.ok(j1.id);
    const r2 = await app.fetch(req("POST", "/api/watches", b, h), env());
    const j2 = await r2.json();
    assert.equal(j2.id, j1.id); // same key → same resource
    const snap = await (await app.fetch(req("GET", "/api/watches/active-snapshot"), env())).json();
    assert.ok(Array.isArray(snap.watches));
  });
  it("S1: a stalk PUBLISHES the watch — DRAFT→ACTIVE, or nothing ever arms it", async () => {
    const b = { symbol: "ETHUSDT", direction: "SHORT", trigger: { op: "<=", price: "3000" }, invalidation: { op: ">=", price: "3100" } };
    const j = await (await app.fetch(req("POST", "/api/watches", b), env())).json();
    // The row is ACTIVE (the trigger loop and the poller read ACTIVE only), the
    // version reflects the publish edge, and the audit trail records it.
    const row = sql(`SELECT status || '|' || version || '|' || created_by FROM watches WHERE id='${j.id}';`).trim();
    assert.equal(row, "ACTIVE|2|trader");
    assert.equal(j.status, "ACTIVE");
    assert.equal(j.version, 2);
    const trans = sql(`SELECT from_s || '->' || to_s || '|' || reason FROM watch_transitions WHERE watch_id='${j.id}';`).trim();
    assert.equal(trans, "DRAFT->ACTIVE|publish (stalk)");
    const evts = sql(`SELECT type FROM events WHERE entity_id='${j.id}' ORDER BY type;`).trim().split("\n");
    assert.deepEqual(evts, ["watch.activated_v1", "watch.created_v1"]);
    // and it is visible to the Go cold start + the poller set
    const snap = await (await app.fetch(req("GET", "/api/watches/active-snapshot"), env())).json();
    assert.ok(snap.watches.some((w) => w.id === j.id && w.status === "ACTIVE"));
  });
  it("S2: signal ingest validates kind; bad kind 400", async () => {
    const e = env({ SIGNAL_HMAC_SECRET: "route-test-secret" });
    // E07-T01: /api/signals:ingest is the authenticated webhook (FR-005 "signed
    // payload"); the allowlist is fail-closed, so activate one first.
    await app.fetch(new Request("http://x/api/strategy:activate", {
      method: "POST", headers: { "content-type": "application/json", "x-role": "admin" },
      body: JSON.stringify({ version: "v-test", config: { signal_sources: { ext: ["MTF"] } } }),
    }), e);
    const { signWebhook } = await import("./strategies.mjs");
    const post = async (body) => {
      const rawBody = JSON.stringify(body);
      const t = Date.now(), nonce = `n${Math.random()}`;
      const headers = {
        "content-type": "application/json", "x-signal-source": "ext",
        "x-signal-timestamp": String(t), "x-signal-nonce": nonce,
        "x-signal-signature": await signWebhook("route-test-secret", { timestamp_ms: t, nonce, rawBody }),
      };
      return app.fetch(new Request("http://x/api/signals:ingest", { method: "POST", headers, body: rawBody }), e);
    };
    // unknown kind is rejected by the contract, after auth passes
    assert.equal((await post({ kind: "NOPE", payload: {}, source: "ext" })).status, 400);
    const good = await post({
      kind: "MTF",
      payload: { symbol: "BTCUSDT", timeframes: [{ tf: "1h", bias: "LONG" }, { tf: "4h", bias: "LONG" }], agreement: "LONG" },
      source: "ext",
    });
    assert.equal(good.status, 201);
    assert.equal((await good.json()).schema_version, "1");
  });
  it("S2: approval grant issues expiring token; analysis run stored", async () => {
    // The run route asks the LIVE engine and stores what it answered (E14-T03):
    // stub the Go plane, and give it a real watch to analyze.
    sql("INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) " +
      "VALUES('w1','BTCUSDT','LONG','{}','{}','ACTIVE',1,'test','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');");
    const stub = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
      if (u.endsWith("/strategies/registry")) return json({ count: 1, strategies: [{ id: "sma-cross", version: "0.1.0" }] });
      return json({
        id: "an_engine_1", symbol: "BTCUSDT", at: "2026-10-16T00:00:00Z",
        aggregate: { bias: "FLAT", confidence: 0, agree: 0, disagree: 0, flat: 1, errors: 0, n: 1, explanation: "1 verdicts (0 errors): longW=0.00 shortW=0.00 flat=1" },
        verdicts: [{ strategy_id: "sma-cross", strategy_version: "0.1.0", timeframe: "15m", data_source: "toobit-rest", result: { status: "NO_SIGNAL", decision: { bias: "FLAT", confidence: 0 }, diagnostics: { reason: "windows equal" } } }],
      });
    };
    try {
      const an = await (await app.fetch(req("POST", "/api/analysis:runs", { watch_id: "w1" }), env({ GO_WATCHER_URL: "https://go.test" }))).json();
      assert.equal(an.bias, "FLAT");
      const ap = await app.fetch(req("POST", "/api/approvals",
        { watch_id: "w1", analysis_id: an.id, decision: "approve", reason: "t" }), env());
      assert.equal(ap.status, 201);
      const j = await ap.json();
      assert.ok(j.expires_at);
    } finally { globalThis.fetch = stub; }
  });
});
