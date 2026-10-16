// health-api.test.mjs — E06-T01-S2: cron persistence + badge API (sqlite-backed).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbFile = join(tmpdir(), `e06t01-${Date.now()}.sqlite`);
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

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
      let s = this._s, i = 0;
      return s.replaceAll("?", () => {
        const v = this._a[i++];
        if (v === null || v === undefined) return "NULL";
        return `'${String(v).replaceAll("'", "''")}'`;
      });
    },
    async all() {
      if (!/^\s*SELECT/i.test(stmt)) { sql(this._fill()); return { results: [] }; }
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
before(async () => {
  const tmp = join(tmpdir(), `hinit-${Date.now()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
});
const env = () => ({ DB: fakeDb(), ENV: "test" });

describe("E06-T01-S2 persistence + badge API", () => {
  it("tick writes 6 rows; badge API serves mode", async () => {
    const { tick } = await import("./health-route.mjs");
    const next = await tick(env(), { now_ms: Date.now(), go_heartbeat_ms: 0, stream_lag_ms: 0, price_lag_ms: 0, d1_down: false });
    assert.equal(next.mode, "DEGRADED");
    assert.match(sql("SELECT COUNT(*) FROM health_snapshots;").trim(), /7/); // 6 components + mode
    const app = (await import("./index.mjs")).default;
    const j = await (await app.fetch(new Request("http://x/api/health"), env())).json();
    assert.ok(["PRIMARY", "DEGRADED", "FALLBACK", "HALTED", "D1_DOWN"].includes(j.mode));
    assert.ok(j.badge);
    // D-06 honesty: the badge API always says which adapter fills an order, so a
    // simulated fill can never be read as a live one. Derived from the runtime —
    // an injected test/drill adapter changes it.
    assert.equal(j.execution_venue, "paper-sim");
    const injected = await (await app.fetch(new Request("http://x/api/health"), { ...env(), EXCHANGE: { submit: async () => ({}) } })).json();
    assert.equal(injected.execution_venue, "injected-adapter");
  });
  it("recovery log records and lists incidents", async () => {
    const { recordIncident } = await import("./health-route.mjs");
    await recordIncident(env(), "mode:DEGRADED", "go_unhealthy", "health-cron");
    const app = (await import("./index.mjs")).default;
    const j = await (await app.fetch(new Request("http://x/api/recovery/log?limit=5"), env())).json();
    assert.ok(j.incidents.length >= 1);
    assert.equal(j.incidents[0].incident, "mode:DEGRADED");
  });
});
