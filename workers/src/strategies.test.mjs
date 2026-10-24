// strategies.test.mjs — E07-T01-S2: version registry + HMAC webhook (node:test,
// stdlib + the repo's sqlite-backed fake D1). Acceptance frame: (1) provenance
// is an authenticated source identity, never a JSON claim; (2) the strategy
// version is pinned at run start; (3) unknown version/disallowed source/reject
// is a rejection with a recorded incident; (4) the allowlist is extensible
// config; (5) provenance never proves validity — R-gates decide in E08.
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
  const tmp = join(tmpdir(), `e07q-${Date.now()}-${Math.random()}.sql`);
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
      const tmp = join(tmpdir(), `e07s-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
  });
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}
function freshEnv(extra = {}) {
  dbFile = join(tmpdir(), `e07t01-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `e07i-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
  return { DB: fakeDb(), ENV: "test", ...extra };
}
const mtf = {
  watch_id: "w1", kind: "MTF",
  payload: { symbol: "BTCUSDT", timeframes: [{ tf: "1h", bias: "LONG" }, { tf: "4h", bias: "LONG" }], agreement: "LONG" },
};
const signed = async (secret, source, body, skewMs = 0) => {
  const { signWebhook } = await import("./strategies.mjs");
  const rawBody = JSON.stringify(body);
  const timestamp_ms = Date.now() + skewMs;
  const nonce = `n-${Date.now()}-${Math.random()}`;
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-signal-source": source,
      "x-signal-timestamp": String(timestamp_ms),
      "x-signal-nonce": nonce,
      "x-signal-signature": await signWebhook(secret, { timestamp_ms, nonce, rawBody }),
    },
  };
};
const post = (app, env, path, rawBody, headers, role = "trader") =>
  app.fetch(new Request(`http://x${path}`, {
    method: "POST", headers: { "x-role": role, ...headers }, body: rawBody,
  }), env);

let app;
before(async () => { app = (await import("./index.mjs")).default; });

// The run route talks to the LIVE Go engine (registry + /analyze) and persists
// what it answered. Tests stub that engine at the fetch boundary — the pinning
// assertions below are about OUR pinning, not about the engine's verdict.
const ENGINE_AGG = { bias: "LONG", confidence: 0.31, agree: 1, disagree: 0, flat: 0, errors: 0, n: 1, explanation: "1 verdicts (0 errors): longW=0.62 shortW=0.00 flat=0" };
function stubEngine({ registryStatus = 200, analyzeStatus = 200, aggregate = ENGINE_AGG, seen = [] } = {}) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push({ url: u, method: init?.method, body: init?.body });
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/strategies/registry")) {
      return registryStatus === 200
        ? json({ count: 1, strategies: [{ id: "sma-cross", version: "0.1.0", file: "sma-cross-0.1.0.wasm" }], at: "2026-10-16T00:00:00Z" })
        : json({ code: "DEGRADED" }, registryStatus);
    }
    if (u.endsWith("/analyze")) {
      return analyzeStatus === 200
        ? json({
            id: "an_engine_1", symbol: "BTCUSDT", at: "2026-10-16T00:00:00Z", aggregate,
            verdicts: [{ strategy_id: "sma-cross", strategy_version: "0.1.0", timeframe: "15m", data_source: "toobit-rest", result: { status: "SIGNAL", decision: { bias: "LONG", confidence: 0.62 }, diagnostics: { reason: "cross" } } }],
            suggest_zones: { timeframe: "15m", source: "toobit-rest", bars: 120, atr: "1", trigger_long: "2", inval_long: "0.5", trigger_short: "1.5", inval_short: "2.5" },
          })
        : json({ code: "DATA_UNAVAILABLE", message: "klines" }, analyzeStatus);
    }
    return new Response("unexpected url", { status: 404 });
  };
}
const clearStub = () => { delete globalThis.fetch; };

const V2 = { max_leverage: 5, signal_sources: { go_watcher: ["MTF", "REGIME"], quant_desk: ["DIVERGENCE_TRIPLE", "OB_OS"] } };


describe("E07-T01-S2a version activation + run pinning", () => {
  // The run route resolves the watch from D1 (a run is about a real watch) and
  // reads the engine's answer; both need to exist before the run can be stored.
  const WATCH_ROW = "INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) " +
    "VALUES('w1','BTCUSDT','LONG','{}','{}','ACTIVE',1,'test','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');";
  const runReq = () => new Request("http://x/api/analysis:runs",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ watch_id: "w1" }) });

  it("seed v1-paper is active by default; runs pin it", async () => {
    const env = { ...freshEnv(), GO_WATCHER_URL: "https://go.test" };
    sql(WATCH_ROW);
    try {
      stubEngine();
      const run = await app.fetch(runReq(), env);
      assert.equal(run.status, 201);
      assert.equal((await run.json()).strategy_version, "v1-paper");
    } finally { clearStub(); }
  });

  it("operator activates v2 → new runs pin v2, old runs keep v1", async () => {
    const env = { ...freshEnv(), GO_WATCHER_URL: "https://go.test" };
    sql(WATCH_ROW);
    try {
      stubEngine();
      const r1 = await (await app.fetch(runReq(), env)).json();
      assert.equal(r1.strategy_version, "v1-paper");
      const act = await app.fetch(new Request("http://x/api/strategy:activate",
        { method: "POST", headers: { "content-type": "application/json", "x-role": "admin" }, body: JSON.stringify({ version: "v2", config: V2 }) }), env);
      assert.equal(act.status, 201);
      const r2 = await (await app.fetch(runReq(), env)).json();
      assert.equal(r2.strategy_version, "v2");
      const rows = JSON.parse(sql(".mode json\nSELECT output_json FROM analysis_runs ORDER BY at;"));
      assert.equal(JSON.parse(rows[0].output_json).strategy_version, "v1-paper");
      assert.equal(JSON.parse(rows[1].output_json).strategy_version, "v2");
    } finally { clearStub(); }
  });

  it("a stored run is the ENGINE's answer, with provenance — never a local placeholder", async () => {
    const env = { ...freshEnv(), GO_WATCHER_URL: "https://go.test" };
    sql(WATCH_ROW);
    const seen = [];
    try {
      stubEngine({ seen });
      const body = await (await app.fetch(runReq(), env)).json();
      assert.equal(body.bias, "LONG");                       // the engine said LONG, not "FLAT stub"
      assert.equal(body.confidence, 0.31);
      assert.notEqual(body.model, "stub");
      // The engine was asked about the WATCH's symbol/direction and the
      // registry's pins (the bytes the runner executes) — not a local list.
      const ask = JSON.parse(Buffer.from(seen.find((s) => s.url.endsWith("/analyze")).body).toString());
      assert.equal(ask.symbol, "BTCUSDT");
      assert.equal(ask.direction, "LONG");
      assert.deepEqual(ask.strategies, [{ id: "sma-cross", version: "0.1.0", config: {} }]);
      const rows = JSON.parse(sql(".mode json\nSELECT model, confidence, input_hash, output_json FROM analysis_runs;"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].model, "wasm-engine");
      assert.equal(rows[0].confidence, 0.31);
      assert.match(rows[0].input_hash, /^[0-9a-f]{64}$/);    // digest of the exact request
      const out = JSON.parse(rows[0].output_json);
      assert.deepEqual(out.engine.data_sources, ["toobit-rest"]);
      assert.equal(out.engine.analyze_id, "an_engine_1");
      assert.equal(out.engine.verdicts[0].timeframe, "15m");
    } finally { clearStub(); }
  });

  it("engine unreachable → 503 DEGRADED and NO computed row is invented", async () => {
    for (const opts of [{ registryStatus: 502 }, { analyzeStatus: 500 }, { analyzeStatus: 200, aggregate: {} }]) {
      const env = { ...freshEnv(), GO_WATCHER_URL: "https://go.test" };
      sql(WATCH_ROW);
      try {
        stubEngine(opts);
        const res = await app.fetch(runReq(), env);
        assert.equal(res.status, 503, JSON.stringify(opts));
        assert.equal((await res.json()).code, "DEGRADED", JSON.stringify(opts));
        // The whole point of this test: nothing was written that a human could
        // later mistake for a real analysis.
        assert.equal(sql("SELECT COUNT(*) FROM analysis_runs;").trim(), "0", JSON.stringify(opts));
      } finally { clearStub(); }
    }
  });

  it("an unknown watch is 404 (a run is about a real watch), not a synthetic row", async () => {
    const env = { ...freshEnv(), GO_WATCHER_URL: "https://go.test" };
    try {
      stubEngine();
      const res = await app.fetch(runReq(), env); // freshEnv seeds no watches
      assert.equal(res.status, 404);
      assert.equal(sql("SELECT COUNT(*) FROM analysis_runs;").trim(), "0");
    } finally { clearStub(); }
  });

  it("activation is admin-only; non-JSON config rejected", async () => {
    const env = freshEnv();
    // RBAC matrix: strategy activation is admin-only (strictest role); operator
    // and trader are both denied (SAFE-010 separation of duties).
    for (const role of ["trader", "operator"]) {
      const denied = await app.fetch(new Request("http://x/api/strategy:activate",
        { method: "POST", headers: { "content-type": "application/json", "x-role": role }, body: JSON.stringify({ version: "v2", config: V2 }) }), env);
      assert.equal(denied.status, 403, role);
    }
    // chain now runs 0001..0010, so seed strategy_configs holds v1-paper + v2-paper
    assert.equal(sql("SELECT COUNT(*) FROM strategy_configs;").trim(), "2");
    const bad = await app.fetch(new Request("http://x/api/strategy:activate",
      { method: "POST", headers: { "content-type": "application/json", "x-role": "admin" }, body: JSON.stringify({ version: "v2", config: "{nope" }) }), env);
    assert.equal(bad.status, 400);
  });
});
describe("E07-T01-S2b HMAC webhook + allowlist", () => {
  const SECRET = "test-secret-for-vectors-only";
  const withV2 = async () => {
    const env = freshEnv({ SIGNAL_HMAC_SECRET: SECRET });
    await app.fetch(new Request("http://x/api/strategy:activate",
      { method: "POST", headers: { "content-type": "application/json", "x-role": "admin" }, body: JSON.stringify({ version: "v2", config: V2 }) }), env);
    return env;
  };
  it("valid signature from an allowlisted source stores the VERIFIED source", async () => {
    const env = await withV2();
    const { rawBody, headers } = await signed(SECRET, "go_watcher", mtf);
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 201);
    assert.equal(sql("SELECT source FROM signals LIMIT 1;").trim(), "go_watcher");
    const row = JSON.parse(sql(".mode json\nSELECT payload_json FROM signals LIMIT 1;"))[0];
    assert.equal(JSON.parse(row.payload_json)._schema_version, "1");
  });
  it("the body's source claim is ignored — the HMAC identity wins", async () => {
    const env = await withV2();
    const { rawBody, headers } = await signed(SECRET, "go_watcher", { ...mtf, source: "quant_desk" });
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 201);
    assert.equal(sql("SELECT source FROM signals LIMIT 1;").trim(), "go_watcher");
  });
  it("tampered signature → 401 + signal.auth_rejected incident, nothing stored", async () => {
    const env = await withV2();
    const { rawBody, headers } = await signed(SECRET, "go_watcher", mtf);
    headers["x-signal-signature"] = "0".repeat(64);
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 401);
    assert.equal(sql("SELECT COUNT(*) FROM recovery_log WHERE incident='signal.auth_rejected';").trim(), "1");
    assert.equal(sql("SELECT COUNT(*) FROM signals;").trim(), "0");
  });
  it("replayed nonce → 401 the second time", async () => {
    const env = await withV2();
    const { rawBody, headers } = await signed(SECRET, "go_watcher", mtf);
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 201);
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 401);
    assert.equal(sql("SELECT COUNT(*) FROM signals;").trim(), "1");
  });
  it("stale timestamp (>30s skew) → 401", async () => {
    const env = await withV2();
    const { rawBody, headers } = await signed(SECRET, "go_watcher", mtf, -60_000);
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 401);
  });
  it("valid HMAC but unlisted source for the kind → 403 provenance + incident", async () => {
    const env = await withV2();
    const { rawBody, headers } = await signed(SECRET, "quant_desk", mtf);
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 403);
    assert.equal(sql("SELECT COUNT(*) FROM recovery_log WHERE incident='signal.provenance_rejected';").trim(), "1");
    assert.equal(sql("SELECT COUNT(*) FROM signals;").trim(), "0");
  });
  it("the allowlist is extensible config — adding a source needs no code", async () => {
    const env = freshEnv({ SIGNAL_HMAC_SECRET: SECRET });
    const ext = { max_leverage: 5, signal_sources: { new_desk: ["MTF"], go_watcher: ["MTF"] } };
    await app.fetch(new Request("http://x/api/strategy:activate",
      { method: "POST", headers: { "content-type": "application/json", "x-role": "admin" }, body: JSON.stringify({ version: "v3", config: ext }) }), env);
    const { rawBody, headers } = await signed(SECRET, "new_desk", mtf);
    assert.equal((await post(app, env, "/api/signals:ingest", rawBody, headers)).status, 201);
  });
});

