// routes2-regime.test.mjs — the per-watch regime filter is WIRED end to end:
// POST /api/analysis:runs and POST /api/watches:trigger -> analyzeWatch ->
// evaluateRegime -> the persisted analysis_runs row the dashboard reads.
//
// The Go engine is stubbed at global fetch (the same seam production uses), and
// the index feed is injected via env.REGIME_FEED (the seam tests use for
// env.EXCHANGE) so no test touches the network.
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { miscRoutes } from "./routes2.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbFile = join(tmpdir(), `regime-wire-${Date.now()}.sqlite`);
const chain = [
  "migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql",
  "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql",
  "migrations/0006_notify_outbox.sql", "migrations/0007_notify_prefs.sql",
  "migrations/0008_stop_loss.sql", "migrations/0009_slot_cap.sql",
  "migrations/0010_regime_filter.sql",
].map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

const esc = (v) => String(v).replaceAll("'", "''");
function sql(q) {
  const tmp = join(tmpdir(), `rw-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try { return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }); }
  finally { rmSync(tmp, { force: true }); }
}
// Minimal D1-compatible fake (same shape as routes.test.mjs).
function fakeDb() {
  const prep = (stmt) => {
    const p = {
      _s: stmt, _a: [],
      bind(...a) { p._a = a; return p; },
      _fill() {
        let i = 0;
        return p._s.replaceAll("?", () => {
          const v = p._a[i++];
          if (v === null || v === undefined) return "NULL";
          return `'${esc(v)}'`;
        });
      },
      async all() {
        if (!/^\s*SELECT/i.test(p._s)) { sql(p._fill()); return { results: [] }; }
        const tmp = join(tmpdir(), `rwsel-${Date.now()}-${Math.random()}.sql`);
        writeFileSync(tmp, `.mode json\n${p._fill()}`);
        try {
          const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
          return { results: raw ? JSON.parse(raw) : [] };
        } finally { rmSync(tmp, { force: true }); }
      },
      async run() { sql(p._fill()); return {}; },
    };
    return p;
  };
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}

const misc = miscRoutes();
const env = (extra = {}) => ({ DB: fakeDb(), ENV: "test", GO_WATCHER_URL: "https://go.test", ...extra });
const post = (path, body, headers = {}) => new Request(`http://x${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const rising = (n = 60) => Array.from({ length: n }, (_, i) => String(100 + i));
const falling = (n = 60) => Array.from({ length: n }, (_, i) => String(100 - i));
const EMPTY_PRICES = { ETHBTC: null, "USDT.D": null, "BTC.D": null, TOTAL3: null };
// Two indices up / two down => no majority => CHOP.
const CHOP_PRICES = { ETHBTC: rising(), "BTC.D": falling(), "USDT.D": rising(), TOTAL3: falling() };
// Every index down => BEARISH.
const BEARISH_PRICES = { ETHBTC: falling(), "BTC.D": falling(), "USDT.D": falling(), TOTAL3: falling() };

function addWatch(id, { symbol = "ETHUSDT", direction = "LONG", regime = 1, status = "ACTIVE" } = {}) {
  sql("INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,regime_filter,created_at,updated_at) " +
    `VALUES('${id}','${symbol}','${direction}','{}','{}','${status}',1,'test',${regime},'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');`);
}
// The newest strategy_configs row wins (activeVersion orders by `at` DESC).
// Each activation gets its own version/timestamp so tests never collide on the
// primary key and "newest" is unambiguous.
let configSeq = 0;
function activateRegime(regime) {
  configSeq += 1;
  const at = `2999-01-01T00:00:${String(configSeq).padStart(2, "0")}Z`;
  sql(`INSERT INTO strategy_configs(version,config_json,activated_by,at) VALUES('v3-regime-${configSeq}','${esc(JSON.stringify({ regime }))}','test','${at}');`);
}

// Stub the Go plane. Every call is recorded so a test can prove the engine was
// NOT consulted on a veto.
function stubEngine(calls, confidence = 0.8, bias = "LONG") {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const j = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (String(url).endsWith("/strategies/registry")) {
      return j({ count: 1, strategies: [{ id: "sma-cross", version: "0.1.0" }] });
    }
    return j({
      id: "an_engine_1", symbol: "ETHUSDT", at: "2026-10-16T00:00:00Z",
      aggregate: { bias, confidence, agree: 1, disagree: 0, flat: 0, errors: 0, n: 1, explanation: "1 verdicts (0 errors)" },
      verdicts: [{
        strategy_id: "sma-cross", strategy_version: "0.1.0", timeframe: "15m", data_source: "toobit-rest",
        result: { status: "SIGNAL", decision: { bias, confidence }, diagnostics: { reason: "engine says so" } },
      }],
    });
  };
}

const realFetch = globalThis.fetch;
before(() => {
  const tmp = join(tmpdir(), `rwinit-${Date.now()}.sql`);
  writeFileSync(tmp, chain);
  try { execSync(`sqlite3 ${dbFile} < "${tmp}"`); } finally { rmSync(tmp, { force: true }); }
});
afterEach(() => { globalThis.fetch = realFetch; });

const analysisRow = (watchId) =>
  JSON.parse(sql(`SELECT output_json FROM analysis_runs WHERE watch_id='${watchId}' ORDER BY at DESC LIMIT 1;`).trim());


describe("regime filter wiring (analysis runs)", () => {
  it("VETO stores FLAT @ confidence 0 and never calls the engine", async () => {
    addWatch("w_veto");
    activateRegime({ veto_altcoin_long: ["BEARISH", "UNKNOWN"], action_on_veto: "BLOCK", confidence_penalty: 0.3 });
    const calls = [];
    stubEngine(calls);
    const feedCalls = [];
    const feed = async () => { feedCalls.push(1); return BEARISH_PRICES; };

    const res = await misc.runAnalysis(post("/api/analysis:runs", { watch_id: "w_veto" }), env({ REGIME_FEED: feed }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.bias, "FLAT");
    assert.equal(body.confidence, 0);
    assert.equal(body.model, "regime-filter");
    assert.equal(body.engine, null);
    assert.equal(body.regime.verdict, "VETO");
    assert.equal(body.regime.force_flat, true);
    assert.equal(feedCalls.length, 1);
    assert.deepEqual(calls, [], "a veto must not depend on the engine being reachable");

    const row = analysisRow("w_veto");
    assert.equal(row.bias, "FLAT");
    assert.equal(row.confidence, 0);
    assert.equal(row.regime.verdict, "VETO");
    assert.match(row.reasons[0], /regime veto/);
  });

  it("WARN (CHOP) runs the engine and reduces confidence by the penalty", async () => {
    addWatch("w_chop");
    activateRegime({ confidence_penalty: 0.5, action_on_veto: "BLOCK" });
    const calls = [];
    stubEngine(calls, 0.8);
    const res = await misc.runAnalysis(
      post("/api/analysis:runs", { watch_id: "w_chop" }),
      env({ REGIME_FEED: async () => CHOP_PRICES }),
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.bias, "LONG");
    assert.equal(body.confidence, 0.4, "0.8 * (1 - 0.5)");
    assert.equal(body.regime.verdict, "WARN");
    assert.equal(body.regime.regime, "CHOP");
    assert.ok(calls.some((u) => u.endsWith("/analyze")), "the engine still produces the bias");
    assert.match(body.reasons.join(" "), /confidence −50%/);
  });

  it("regime_filter=0 => the feed is never called and confidence is untouched", async () => {
    addWatch("w_off", { regime: 0 });
    activateRegime({ confidence_penalty: 0.5 });
    const calls = [];
    stubEngine(calls, 0.9);
    const feed = async () => { throw new Error("feed must not be called when the watch opted out"); };
    const res = await misc.runAnalysis(post("/api/analysis:runs", { watch_id: "w_off" }), env({ REGIME_FEED: feed }));
    const body = await res.json();
    assert.equal(body.confidence, 0.9);
    assert.equal(body.regime, null);
    assert.equal(body.model, "wasm-engine");
  });

  it("a throwing feed fails closed (UNKNOWN) for an altcoin instead of passing", async () => {
    addWatch("w_feed_down");
    activateRegime({ veto_altcoin_long: ["BEARISH", "UNKNOWN"], action_on_veto: "BLOCK" });
    const calls = [];
    stubEngine(calls);
    const res = await misc.runAnalysis(
      post("/api/analysis:runs", { watch_id: "w_feed_down" }),
      env({ REGIME_FEED: async () => { throw new Error("all four indices unreachable"); } }),
    );
    const body = await res.json();
    assert.equal(body.bias, "FLAT");
    assert.equal(body.confidence, 0);
    assert.equal(body.regime.regime, "UNKNOWN");
    assert.equal(body.regime.verdict, "VETO");
    assert.deepEqual(calls, []);
  });

  it("operator disabled the gate globally => recorded PASS, engine runs, no feed call", async () => {
    addWatch("w_disabled");
    activateRegime({ enabled: false, confidence_penalty: 0.5 });
    const calls = [];
    stubEngine(calls, 0.7);
    const res = await misc.runAnalysis(
      post("/api/analysis:runs", { watch_id: "w_disabled" }),
      env({ REGIME_FEED: async () => { throw new Error("not needed when disabled"); } }),
    );
    const body = await res.json();
    assert.equal(body.confidence, 0.7);
    assert.equal(body.regime.verdict, "PASS");
    assert.match(body.regime.reason, /disabled/);
    assert.ok(calls.some((u) => u.endsWith("/analyze")));
  });

  it("BTC LONG + no usable index => VETO even with the default (unactivated) config", async () => {
    addWatch("w_btc", { symbol: "BTCUSDT", direction: "LONG" });
    // A config row that carries no `regime` block at all — the defaults must apply.
    activateRegime({});
    const calls = [];
    stubEngine(calls);
    const res = await misc.runAnalysis(
      post("/api/analysis:runs", { watch_id: "w_btc" }),
      env({ REGIME_FEED: async () => EMPTY_PRICES }),
    );
    const body = await res.json();
    assert.equal(body.bias, "FLAT");
    assert.equal(body.regime.verdict, "VETO");
    assert.deepEqual(calls, []);
  });
});

describe("regime filter wiring (trigger route)", () => {
  it("a triggered watch with a hostile regime lands ANALYZED as FLAT and stays auditable", async () => {
    addWatch("w_trig");
    activateRegime({ veto_altcoin_long: ["BEARISH", "UNKNOWN"], action_on_veto: "BLOCK" });
    const calls = [];
    stubEngine(calls);
    const req = post(
      "/api/watches:trigger",
      { watch_id: "w_trig", kind: "TRIGGERED", px: "2500", prev_px: "2510", seq: 1, watch_version: 1 },
      { "x-agent-token": "agent-secret" },
    );
    const res = await misc.triggerWatch(req, env({ GO_AGENT_TOKEN: "agent-secret", REGIME_FEED: async () => BEARISH_PRICES }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, "ANALYZED");
    assert.equal(body.bias, "FLAT");
    assert.equal(body.confidence, 0);
    assert.equal(body.model, "regime-filter");
    assert.deepEqual(calls, []);

    const w = sql("SELECT status || '|' || version FROM watches WHERE id='w_trig';").trim();
    // ACTIVE v1 -> TRIGGERED v2 -> ANALYZED v3 (both FSM edges are audited).
    assert.equal(w, "ANALYZED|3");
    const row = analysisRow("w_trig");
    assert.equal(row.regime.verdict, "VETO");
    assert.equal(row.engine, null);
  });
});
