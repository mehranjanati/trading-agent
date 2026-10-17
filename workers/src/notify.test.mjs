// notify.test.mjs — Telegram outbox: format, enqueue idempotency, topic gate, drain.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAlert, esc, telegramConfig, isTopic, TOPICS } from "./notify.mjs";

describe("notify topics", () => {
  it("lists the seven alert topics", () => {
    assert.deepEqual(TOPICS, ["TRIGGERED", "INVALIDATED", "ANALYSIS_READY", "APPROVAL_REQUESTED", "ORDER_UPDATE", "SAFETY", "POSITION_DIGEST"]);
    for (const t of TOPICS) assert.equal(isTopic(t), true);
    assert.equal(isTopic("NOPE"), false);
  });
  it("escapes HTML specials", () => {
    assert.equal(esc("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
  });
});

describe("formatAlert (fa)", () => {
  it("TRIGGERED is Persian with price", () => {
    const t = formatAlert({ topic: "TRIGGERED", symbol: "BTCUSDT", direction: "LONG", px: "67000.5" });
    assert.match(t, /تریگر شد/);
    assert.match(t, /BTCUSDT/);
    assert.match(t, /67000\.5/);
  });
  it("ANALYSIS_READY carries bias + confidence", () => {
    const t = formatAlert({ topic: "ANALYSIS_READY", symbol: "ETHUSDT", extra: { bias: "SHORT", confidence: 0.72 } });
    assert.match(t, /تحلیل آماده شد/);
    assert.match(t, /SHORT/);
    assert.match(t, /0\.72/);
  });
  it("SAFETY carries title + detail", () => {
    const t = formatAlert({ topic: "SAFETY", extra: { title: "kill switch", detail: "engaged by op" } });
    assert.match(t, /هشدار ایمنی/);
    assert.match(t, /kill switch/);
  });
});

describe("telegramConfig", () => {
  it("fails closed without token or chat id", () => {
    assert.equal(telegramConfig({}).ok, false);
    assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: "t" }).ok, false);
    assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }).ok, true);
  });
});

describe("drainNotifications", () => {
  const memDb = (outbox = [], prefs = {}) => {
    const state = { outbox: [...outbox], prefs: { ...prefs } };
    const prepare = (sql) => ({
      _sql: sql, _binds: [],
      bind(...b) { this._binds = b; return this; },
      async all() {
        if (this._sql.includes("FROM notification_outbox")) {
          const [max, limit] = this._binds;
          return { results: state.outbox.filter((r) => !r.sent_at && r.attempts < max).slice(0, limit) };
        }
        if (this._sql.includes("FROM notify_prefs")) {
          const t = this._binds[0];
          return { results: t in state.prefs ? [{ enabled: state.prefs[t] }] : [] };
        }
        return { results: [] };
      },
      async run() {
        if (this._sql.startsWith("INSERT INTO notification_outbox")) {
          const [id, topic, symbol, payload_json, dedupe_key] = this._binds;
          if (state.outbox.some((r) => r.dedupe_key === dedupe_key)) return {};
          state.outbox.push({ id, topic, symbol, payload_json, dedupe_key, attempts: 0, sent_at: null });
          return {};
        }
        if (this._sql.startsWith("UPDATE notification_outbox SET sent_at")) {
          const [at, id] = this._binds;
          const r = state.outbox.find((x) => x.id === id);
          if (r) { r.sent_at = at; r.attempts++; }
          return {};
        }
        if (this._sql.startsWith("UPDATE notification_outbox SET attempts")) {
          const [n, id] = this._binds;
          const r = state.outbox.find((x) => x.id === id);
          if (r) r.attempts = n;
          return {};
        }
        return {};
      },
    });
    return { prepare, _state: state };
  };
  const row = (over = {}) => ({
    id: "ntf_1", topic: "TRIGGERED", symbol: "BTCUSDT",
    payload_json: JSON.stringify({ direction: "LONG", px: "1" }),
    dedupe_key: "k1", attempts: 0, sent_at: null, ...over,
  });

  it("enqueue is idempotent per dedupe_key", async () => {
    const { enqueueAlert } = await import("./notify.mjs");
    const env = { DB: memDb() };
    await enqueueAlert(env, { topic: "TRIGGERED", symbol: "BTCUSDT", dedupeKey: "same" });
    await enqueueAlert(env, { topic: "TRIGGERED", symbol: "BTCUSDT", dedupeKey: "same" });
    assert.equal(env.DB._state.outbox.length, 1);
  });

  it("drain sends via fetch stub and marks sent", async () => {
    const { drainNotifications } = await import("./notify.mjs");
    const env = { DB: memDb([row()]), TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "123" };
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    };
    const r = await drainNotifications(env, { fetchFn });
    assert.deepEqual(r, { sent: 1, skipped: 0, deferred: 0, unconfigured: false, reason: null });
    assert.match(calls[0].url, /bottok\/sendMessage/);
    assert.equal(calls[0].body.chat_id, "123");
    assert.match(calls[0].body.text, /تریگر شد/);
    assert.ok(env.DB._state.outbox[0].sent_at);
  });

  it("drain respects disabled topics and missing config", async () => {
    const { drainNotifications } = await import("./notify.mjs");
    const env = { DB: memDb([row({ id: "a", topic: "TRIGGERED" })], { TRIGGERED: 0 }), TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" };
    const r = await drainNotifications(env, { fetchFn: async () => { throw new Error("no-call"); } });
    assert.equal(r.skipped, 1);
    assert.equal(r.sent, 0);
    const env2 = { DB: memDb([row()]) };
    const r2 = await drainNotifications(env2, { fetchFn: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
    assert.equal(r2.unconfigured, true);
    assert.equal(r2.deferred, 1);
  });

  it("send failure defers (no throw, no mark)", async () => {
    const { drainNotifications } = await import("./notify.mjs");
    const env = { DB: memDb([row()]), TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" };
    const r = await drainNotifications(env, { fetchFn: async () => { throw new Error("net down"); } });
    assert.equal(r.deferred, 1);
    assert.equal(env.DB._state.outbox[0].sent_at, null);
    assert.equal(env.DB._state.outbox[0].attempts, 1);
  });
});

describe("notify prefs routes", () => {
  const memDb = (prefs = []) => {
    const state = { prefs: [...prefs] };
    const prepare = (sql) => ({
      _sql: sql, _binds: [],
      bind(...b) { this._binds = b; return this; },
      async all() {
        if (this._sql.includes("FROM notify_prefs")) return { results: state.prefs };
        return { results: [] };
      },
      async run() {
        if (this._sql.startsWith("INSERT INTO notify_prefs")) {
          const [topic, enabled] = this._binds;
          const ex = state.prefs.find((p) => p.topic === topic);
          if (ex) ex.enabled = enabled;
          else state.prefs.push({ topic, enabled });
          return {};
        }
        return {};
      },
    });
    return { prepare, _state: state };
  };
  const req = (body, role = "trader") => ({
    headers: { get: (k) => (k === "x-role" ? role : null) },
    json: async () => body,
  });

  it("GET lists all topics enabled by default", async () => {
    const { miscRoutes } = await import("./routes2.mjs");
    const res = await miscRoutes().listNotifyPrefs(req({}), { DB: memDb() });
    const j = await res.json();
    assert.equal(j.prefs.length, 7);
    assert.ok(j.prefs.every((p) => p.enabled === true));
  });

  it("GET reflects saved prefs", async () => {
    const { miscRoutes } = await import("./routes2.mjs");
    const res = await miscRoutes().listNotifyPrefs(req({}), { DB: memDb([{ topic: "TRIGGERED", enabled: 0 }]) });
    const j = await res.json();
    assert.equal(j.prefs.find((p) => p.topic === "TRIGGERED").enabled, false);
    assert.equal(j.prefs.find((p) => p.topic === "SAFETY").enabled, true);
  });

  it("POST toggles topics; rejects unknown", async () => {
    const { miscRoutes } = await import("./routes2.mjs");
    const env = { DB: memDb() };
    const res = await miscRoutes().setNotifyPrefs(req({ prefs: { TRIGGERED: false, SAFETY: true } }), env);
    const j = await res.json();
    assert.equal(j.updated.length, 2);
    assert.equal(env.DB._state.prefs.find((p) => p.topic === "TRIGGERED").enabled, 0);
    const bad = await miscRoutes().setNotifyPrefs(req({ prefs: { NOPE: true } }), env);
    assert.equal(bad.status, 400);
  });
});
