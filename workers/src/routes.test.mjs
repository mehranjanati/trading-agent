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
const env = () => ({ DB: fakeDb(), ENV: "test" });
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
    assert.ok(Array.isArray(snap.watches)); // snapshot serves (empty until ACTIVE)
  });
  it("S2: signal ingest validates kind; bad kind 400", async () => {
    const bad = await app.fetch(req("POST", "/api/signals:ingest", { kind: "NOPE", payload: {}, source: "s" }), env());
    assert.equal(bad.status, 400);
    const good = await app.fetch(req("POST", "/api/signals:ingest",
      { watch_id: "w1", kind: "MTF", payload: { tf: "4h" }, source: "ext" }), env());
    assert.equal(good.status, 201);
  });
  it("S2: approval grant issues expiring token; analysis run stored", async () => {
    const an = await (await app.fetch(req("POST", "/api/analysis:runs", { watch_id: "w1" }), env())).json();
    assert.equal(an.bias, "FLAT");
    const ap = await app.fetch(req("POST", "/api/approvals",
      { watch_id: "w1", analysis_id: an.id, decision: "approve", reason: "t" }), env());
    assert.equal(ap.status, 201);
    const j = await ap.json();
    assert.ok(j.expires_at);
  });
});
