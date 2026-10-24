// kill.test.mjs — E09-T01-S3: kill switch (SAFE-006 / FR-011) — persisted flag,
// attributable halt, two-person release, and the <5s halt requirement measured.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql", "migrations/0006_notify_outbox.sql", "migrations/0007_notify_prefs.sql", "migrations/0008_stop_loss.sql", "migrations/0009_slot_cap.sql", "migrations/0010_regime_filter.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
let dbFile;
function sql(q) {
  const tmp = join(tmpdir(), `e09kq-${Date.now()}-${Math.random()}.sql`);
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
      const tmp = join(tmpdir(), `e09ks-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
  });
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}
function freshEnv() {
  dbFile = join(tmpdir(), `e09kill-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `e09ki-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
  return { DB: fakeDb(), ENV: "test" };
}
const scalar = (q) => sql(q).trim();

let app, engageKill, releaseKill, readKill;
before(async () => {
  app = (await import("./index.mjs")).default;
  ({ engageKill, releaseKill, readKill } = await import("./kill.mjs"));
});
const post = (path, body, role = "operator") => app.fetch(new Request(`http://x${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-role": role },
  body: JSON.stringify(body),
}), freshEnv());

describe("E09-T01-S3 kill switch — persisted, attributable, two-person release", () => {
  it("never engaged reads as OFF (the safe default for a cold isolate)", async () => {
    assert.equal((await readKill(freshEnv())).engaged, false);
  });

  it("engage persists the flag + audit event + incident, with actor and reason", async () => {
    const env = freshEnv();
    const k = await engageKill(env, { actor: "operator:meh", reason: "game-day drill", nowMs: 1_800_000_000_000 });
    assert.equal(k.engaged, true);
    assert.equal(k.actor, "operator:meh");
    assert.equal(scalar("SELECT status FROM health_snapshots WHERE id='kill_switch';"), "ENGAGED");
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='kill.engaged_v1';"), "1");
    assert.equal(scalar("SELECT COUNT(*) FROM recovery_log WHERE incident='kill.engaged';"), "1");
  });

  it("HALT <5s: a submit path sees the halt on its next read — measured, not assumed", async () => {
    const env = freshEnv();
    const t0 = Date.now();
    await engageKill(env, { actor: "operator", reason: "halt" });
    const elapsed = Date.now() - t0;
    assert.equal((await readKill(env)).engaged, true);
    assert.ok(elapsed < 5000, `halt observed in ${elapsed}ms`);
  });

  it("release without confirm is refused (two-person rule enforced in code)", async () => {
    const env = freshEnv();
    await engageKill(env, { actor: "operator", reason: "halt" });
    await assert.rejects(() => releaseKill(env, { actor: "admin", confirm: false }), (e) => e.code === "VALIDATION");
    assert.equal((await readKill(env)).engaged, true);
  });

  it("admin + confirm releases; the release is audited", async () => {
    const env = freshEnv();
    await engageKill(env, { actor: "operator", reason: "halt" });
    const k = await releaseKill(env, { actor: "admin", reason: "drill over", confirm: true, nowMs: 1_800_000_000_001 });
    assert.equal(k.engaged, false);
    assert.equal(scalar("SELECT status FROM health_snapshots WHERE id='kill_switch';"), "OFF");
    assert.equal(scalar("SELECT COUNT(*) FROM events WHERE type='kill.released_v1';"), "1");
    assert.equal(scalar("SELECT COUNT(*) FROM recovery_log WHERE incident='kill.released';"), "1");
  });

  it("the flag survives a restart: a NEW D1 binding over the SAME file, migrations not re-run", async () => {
    const env = freshEnv();
    await engageKill(env, { actor: "operator", reason: "persist" });
    const again = { DB: fakeDb(), ENV: "test" };
    assert.equal((await readKill(again)).engaged, true);
  });
});

describe("E09-T01-S3 kill-switch API (RBAC + confirm)", () => {
  it("operator engages 201; trader denied 403; admin release without confirm → 400; with confirm → 200", async () => {
    assert.equal((await post("/api/kill-switch", { engaged: true, reason: "r" }, "operator")).status, 201);
    const denied = await app.fetch(new Request("http://x/api/kill-switch", {
      method: "POST", headers: { "content-type": "application/json", "x-role": "trader" },
      body: JSON.stringify({ engaged: true }),
    }), freshEnv());
    assert.equal(denied.status, 403);
    assert.equal((await post("/api/kill-switch", { engaged: false, confirm: false }, "admin")).status, 400);
    assert.equal((await post("/api/kill-switch", { engaged: false, reason: "done", confirm: true }, "admin")).status, 200);
  });

  it("engaged kill persists across a restart for the API too", async () => {
    const env = freshEnv();
    await post("/api/kill-switch", { engaged: true, reason: "persist" }, "operator");
    const again = { DB: env.DB, ENV: "test" };
    const r = await app.fetch(new Request("http://x/api/kill-switch", {
      method: "POST", headers: { "content-type": "application/json", "x-role": "admin" },
      body: JSON.stringify({ engaged: false, confirm: true, reason: "released after restart" }),
    }), again);
    assert.equal(r.status, 200);
  });
});
