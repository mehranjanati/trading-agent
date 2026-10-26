// fallback-poll.test.mjs — E06-T02-S3c: ADR-004 budget proof + fallback quote wiring.
// The 5-minute load runs against scripts/stub-exchange.mjs (weight accounting per A-02)
// on a simulated clock, so "five minutes at a 5s cadence" costs milliseconds and stays
// deterministic. The D1 wiring is exercised against the usual sqlite-backed fake.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStubExchange, syntheticSymbols } from "../../scripts/stub-exchange.mjs";
import { HOLDERS } from "./lease.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql", "migrations/0006_notify_outbox.sql", "migrations/0007_notify_prefs.sql", "migrations/0008_stop_loss.sql", "migrations/0009_slot_cap.sql", "migrations/0010_regime_filter.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

let dbFile = "";
function sql(q) {
  const tmp = join(tmpdir(), `pq-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try { return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }); }
  finally { rmSync(tmp, { force: true }); }
}
function fakeDb() {
  const prep = (stmt) => ({
    _s: stmt, _a: [],
    bind(...a) { this._a = a; return this; },
    _fill() {
      let i = 0;
      return this._s.replaceAll("?", () => {
        const v = this._a[i++];
        if (v === null || v === undefined) return "NULL";
        return `'${String(v).replaceAll("'", "''")}'`;
      });
    },
    async all() {
      if (!/^\s*SELECT/i.test(this._s)) { sql(this._fill()); return { results: [] }; }
      const tmp = join(tmpdir(), `psel-${Date.now()}-${Math.random()}.sql`);
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
function freshEnv(extra = {}) {
  dbFile = join(tmpdir(), `e06t02p-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `pinit-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  try { execSync(`sqlite3 ${dbFile} < "${tmp}"`); } finally { rmSync(tmp, { force: true }); }
  return { DB: fakeDb(), ENV: "test", ...extra };
}
const scalar = (q) => Number(sql(q).trim() || 0);

describe("E06-T02-S3c budget arithmetic + guards (pure)", () => {
  it("floor follows ADR-004: symbols x 1/50 x 2 seconds", async () => {
    const { floorMs, POLL_MS, BUDGET_PER_MIN } = await import("./fallback-poll.mjs");
    assert.equal(POLL_MS, 5_000);
    assert.equal(BUDGET_PER_MIN, 3000);
    assert.equal(floorMs(10), 400);
    assert.equal(floorMs(100), 4_000);
    assert.ok(POLL_MS >= floorMs(10) && POLL_MS >= floorMs(100)); // 5s holds for both
  });

  it("the rolling window guards the per-minute weight budget", async () => {
    const { createWindow } = await import("./fallback-poll.mjs");
    const w = createWindow({ budget: 300, windowMs: 60_000 });
    assert.equal(w.canSpend(0, 100), true);
    w.spend(0, 100);
    assert.equal(w.usage(1), 100);
    w.spend(1_000, 100);
    w.spend(2_000, 100);
    assert.equal(w.canSpend(3_000, 100), false); // 300/300 used
    assert.equal(w.usage(59_000), 300);
    assert.equal(w.usage(60_000), 200); // the oldest hit left the window
    assert.equal(w.canSpend(60_000, 100), true);
  });

  it("parses the futures price payload and the documented 429", async () => {
    const { parseQuotes, priceUrl, canonicalSymbol, venueSymbol, isRateLimited, resetAtFrom, nextBackoffMs, MAX_BACKOFF_MS } = await import("./fallback-poll.mjs");
    // unfiltered/filtered FUTURES shape: dash form (+ si on the bulk list)
    assert.deepEqual(parseQuotes([{ s: "BTC-SWAP-USDT", si: "BTC-SWAP-USDT", p: "6.6" }]), [{ symbol: "BTCUSDT", price: "6.6" }]);
    assert.deepEqual(parseQuotes({ data: [{ symbol: "ETH-SWAP-USDT", price: 2 }] }), [{ symbol: "ETHUSDT", price: "2" }]);
    assert.deepEqual(parseQuotes({ nope: true }), []);
    // The canonical form is the SPOT book on Toobit; a futures read must reject
    // it rather than label a spot price as the venue (TOOBIT-API-FACTS S4).
    assert.deepEqual(parseQuotes([{ s: "BTCUSDT", p: "80312" }], ["BTCUSDT"], { venueForm: true }), []);
    assert.deepEqual(
      parseQuotes([{ s: "BTC-SWAP-USDT", p: "80287" }], ["BTCUSDT"], { venueForm: true }),
      [{ symbol: "BTCUSDT", price: "80287" }],
    );
    // the unfiltered venue answer must never leak into the poll set
    const list = [{ s: "ZEN-SWAP-USDT", p: "6.6" }, { s: "BTC-SWAP-USDT", p: "83838" }];
    assert.deepEqual(parseQuotes(list, ["BTCUSDT"]), [{ symbol: "BTCUSDT", price: "83838" }]);
    assert.deepEqual(parseQuotes(list, ["ETHUSDT"]), []);
    assert.equal(canonicalSymbol("BTC-SWAP-USDT"), "BTCUSDT");
    assert.equal(venueSymbol("BTCUSDT"), "BTC-SWAP-USDT");
    assert.equal(venueSymbol("EDUUSDT"), "EDU-SWAP-USDT");
    assert.equal(venueSymbol("ETHBTC"), "ETHBTC"); // crosses have no USDT-M contract
    assert.equal(venueSymbol("BTC-SWAP-USDT"), "BTC-SWAP-USDT"); // idempotent
    // one weight-1 filtered FUTURES request per symbol (the `symbols=` form is ignored live)
    assert.match(priceUrl("https://api.toobit.com/", "BTCUSDT"), /ticker\/price\?symbol=BTC-SWAP-USDT$/);
    assert.match(priceUrl("https://api.toobit.com", "EDUUSDT"), /ticker\/price\?symbol=EDU-SWAP-USDT$/);
    assert.doesNotMatch(priceUrl("https://api.toobit.com/", "BTCUSDT"), /symbols=/);
    assert.equal(isRateLimited({ status: 429 }), true);
    assert.equal(isRateLimited({ status: 200, body: { code: -1003 } }), true);
    assert.equal(isRateLimited({ status: 200, body: { code: -1015 } }), true);
    assert.equal(isRateLimited({ status: 200, body: [] }), false);
    const headers = new Map([["x-api-limit-reset-timestamp", "61000"]]);
    assert.equal(resetAtFrom({ headers: { get: (k) => headers.get(k) ?? null } }), 61_000);
    // the reset header is authoritative (capped at 60s); otherwise the ladder doubles
    assert.equal(nextBackoffMs(0, 1_000, 30_000, 0), 29_250);
    assert.equal(nextBackoffMs(0, 1_000, 61_000, 0), MAX_BACKOFF_MS); // reset beyond the cap
    assert.equal(nextBackoffMs(0, 1_000, null, 0), 2_000);
    assert.equal(nextBackoffMs(1, 1_000, null, 0), 4_000);
    assert.equal(nextBackoffMs(9, 1_000, null, 0), MAX_BACKOFF_MS);
  });

  it("no fallback quote yet reads as stale, never fresh", async () => {
    const { quoteLagMs, emptyState, POLL_ID } = await import("./fallback-poll.mjs");
    const { TH } = await import("./health.mjs");
    assert.equal(POLL_ID, "poll_quotes");
    assert.equal(quoteLagMs(emptyState(), 10_000), TH.PRICE_STALE_MS + 1);
    assert.equal(quoteLagMs({ newest_at_ms: 9_000 }, 10_000), 1_000);
    assert.equal(quoteLagMs({ newest_at_ms: 99_999_999 }, 10_000), 0); // skew → clamped
  });

  it("the poll set is ACTIVE-only and deterministic (§6.2 S3)", async () => {
    const env = freshEnv();
    const { pollSet, pollSetSql } = await import("./fallback-poll.mjs");
    assert.match(pollSetSql(3), /status='ACTIVE'/);
    assert.match(pollSetSql(3), /LIMIT 3/);
    const at = new Date().toISOString();
    sql("INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) VALUES" +
      `('w1','BTCUSDT','LONG','{}','{}','ACTIVE',1,'t','2026-10-01T00:00:00Z','${at}'),` +
      `('w2','ETHUSDT','LONG','{}','{}','ACTIVE',1,'t','2026-10-02T00:00:00Z','${at}'),` +
      `('w3','SOLUSDT','LONG','{}','{}','DRAFT',1,'t','2026-10-03T00:00:00Z','${at}');`);
    assert.deepEqual(await pollSet(env), ["BTCUSDT", "ETHUSDT"]); // SOLUSDT is not ACTIVE
    assert.deepEqual(await pollSet(env, { limit: 1 }), ["BTCUSDT"]);
  });
});

describe("E06-T02-S3c no-429 proof (stub exchange, simulated clock)", () => {
  for (const n of [10, 100]) {
    it(`N=${n} holds 5s cadence for 5 minutes with zero 429s`, async () => {
      const { tick, createWindow, floorMs, memoryStore, POLL_MS } = await import("./fallback-poll.mjs");
      let simNow = 1_000_000;
      const stub = createStubExchange({ now: () => simNow });
      const port = await stub.listen(0);
      const symbols = syntheticSymbols(n);
      const store = memoryStore();
      const window = createWindow();
      const baseUrl = `http://127.0.0.1:${port}`;
      const rounds = (5 * 60_000) / POLL_MS;
      let ok = 0;

      for (let i = 0; i < rounds; i++) {
        simNow = 1_000_000 + i * POLL_MS;
        const res = await tick({}, { nowMs: simNow, mode: "FALLBACK", store, window, symbols, baseUrl, jitter: () => 0, env: {} });
        if (res.reason === "ok") ok++;
        assert.notEqual(res.reason, "rate-limited", `round ${i} hit a 429`);
      }
      await stub.close();

      assert.equal(ok, rounds, "every round polled");
      assert.equal(stub.stats.limited, 0, "zero 429s");
      assert.equal(stub.stats.requests, rounds * n); // one filtered request per symbol
      assert.ok(stub.usage(simNow) <= 3000, `usage ${stub.usage(simNow)} within REQUEST_WEIGHT`);
      assert.ok(stub.stats.peak_usage <= 3000);
      assert.ok(POLL_MS >= floorMs(n), `cadence ${POLL_MS}ms < floor ${floorMs(n)}ms`);
      // budget math: rounds per minute x weight per round
      const weightPerMin = (60_000 / POLL_MS) * n;
      assert.ok(weightPerMin <= 3000, `weight/min ${weightPerMin} over budget`);
      assert.equal(store.peek().quotes.length, n);
      assert.equal(store.peek().covered, n);
      assert.equal(store.peek().rounds, rounds);
    });
  }

  it("a single transport failure is retried, and retries are weight-accounted", async () => {
    const { tick, createWindow, memoryStore, POLL_RETRIES } = await import("./fallback-poll.mjs");
    assert.equal(POLL_RETRIES, 1);
    const window = createWindow();
    const sleeps = [];
    let calls = 0;
    // first attempt on ETHUSDT dies (cold handshake), the retry succeeds
    const get = async (url) => {
      calls++;
      const sym = new URL(url).searchParams.get("symbol");
      if (sym === "ETH-SWAP-USDT" && calls === 2) throw new Error("This operation was aborted");
      return { status: 200, body: [{ s: sym, p: "1" }] };
    };
    const res = await tick({}, {
      nowMs: 1_000, mode: "FALLBACK", store: memoryStore(), window, symbols: ["BTCUSDT", "ETHUSDT"],
      baseUrl: "http://x", get, jitter: () => 0, env: {}, sleep: async (ms) => sleeps.push(ms),
    });

    assert.equal(res.reason, "ok");
    assert.equal(res.covered, 2);
    assert.equal(res.polls, 3); // 2 symbols + 1 retry
    assert.equal(res.usage, 3); // the retry was counted against the budget
    assert.deepEqual(sleeps, [300]);
  });

  it("a persistently dead transport fails the round after the retry budget", async () => {
    const { tick, createWindow, memoryStore } = await import("./fallback-poll.mjs");
    const window = createWindow();
    let calls = 0;
    const res = await tick({}, {
      nowMs: 1_000, mode: "FALLBACK", store: memoryStore(), window, symbols: ["BTCUSDT", "ETHUSDT"],
      baseUrl: "http://x", jitter: () => 0, env: {}, sleep: async () => {},
      get: async () => { calls++; throw new Error("fetch failed"); },
    });

    assert.equal(res.reason, "transport-error");
    assert.equal(res.error, "fetch failed");
    assert.equal(calls, 2); // 1 attempt + 1 retry, then the round stops
    assert.equal(res.polls, 2);
    assert.equal(res.state.inflight, 0);
    assert.equal(res.state.newest_at_ms, null); // a failed round never claims freshness
    assert.equal(window.usage(1_000), 2); // both attempts accounted
  });

  it("an answer that covers none of our symbols is never counted as fresh", async () => {
    const { tick, createWindow, memoryStore } = await import("./fallback-poll.mjs");
    let simNow = 2_000_000;
    // the venue ignoring our filter (documented live hazard) → only foreign markets back
    const stub = createStubExchange({ now: () => simNow, ignoreFilter: true });
    const port = await stub.listen(0);
    const store = memoryStore();
    const res = await tick({}, {
      nowMs: simNow, mode: "FALLBACK", store, window: createWindow(), symbols: ["BTCUSDT", "ETHUSDT"],
      baseUrl: `http://127.0.0.1:${port}`, jitter: () => 0, env: {},
    });
    await stub.close();

    assert.equal(res.reason, "no-quotes");
    assert.equal(res.quotes, 0);
    assert.equal(store.peek().newest_at_ms, null); // no freshness claim
    assert.equal(store.peek().covered, 0);
    assert.equal(store.peek().inflight, 0);
  });

  it("a shrunken venue budget forces one 429 → backoff incident, then the poller waits", async () => {
    const { tick, createWindow, memoryStore, BACKOFF_INCIDENT } = await import("./fallback-poll.mjs");
    const env = freshEnv();
    let simNow = 5_000_000;
    const stub = createStubExchange({ budgetPerMin: 200, now: () => simNow }); // 2 rounds' worth
    const port = await stub.listen(0);
    const symbols = syntheticSymbols(100); // 100 weight per round
    const store = memoryStore();
    const window = createWindow();
    const baseUrl = `http://127.0.0.1:${port}`;
    const call = (nowMs) => tick(env, { nowMs, mode: "FALLBACK", store, window, symbols, baseUrl, jitter: () => 0 });

    assert.equal((await call(simNow)).reason, "ok");            // 100/200
    simNow += 5_000;
    assert.equal((await call(simNow)).reason, "ok");            // 200/200
    simNow += 5_000;
    const limited = await call(simNow);                          // → 429
    assert.equal(limited.reason, "rate-limited");
    assert.equal(limited.status, 429);
    assert.ok(limited.backoff_until_ms > simNow);

    assert.equal(stub.stats.limited, 1);
    assert.ok(stub.stats.weight <= 200, "the stub never served more than its budget");
    // the ADR alert fired, exactly once, and the next round is held back
    assert.equal(scalar(`SELECT COUNT(*) FROM recovery_log WHERE incident='${BACKOFF_INCIDENT}';`), 1);
    simNow += 1_000;
    const held = await call(simNow);
    assert.equal(held.polls, 0);
    assert.equal(held.reason, "backoff");
    // after the backoff expires the poller resumes: the window has moved on, so this round
    // covers the whole poll set again and does NOT produce another 429
    simNow = limited.backoff_until_ms + 1;
    const resumed = await call(simNow);
    await stub.close();
    assert.equal(resumed.reason, "ok");
    assert.equal(resumed.polls, symbols.length); // one filtered request per symbol
    assert.equal(stub.stats.limited, 1); // no second 429 after waiting out the reset
    assert.equal(store.peek().inflight, 0); // never left in-flight
  });
});

describe("E06-T02-S3c D1 wiring + health/cron integration", () => {
  /** Faithful price fake: echoes the requested (futures/dash) symbol, like the
   *  live filtered endpoint. An empty body means "this symbol is not quoted". */
  const priceGet = (unquoted = []) => async (url) => {
    const raw = new URL(url).searchParams.get("symbol") ?? "";
    const sym = raw.replaceAll("-", "").replaceAll("SWAP", ""); // canonical identity
    if (unquoted.includes(sym)) return { status: 200, body: [] };
    return { status: 200, body: [{ s: raw, p: "1" }] };
  };

  it("the status row is a single fixed-id upsert (no table growth)", async () => {
    const env = freshEnv();
    const { tick: pollOnce, d1Store, pollStatus } = await import("./fallback-poll.mjs");
    const { recordHeartbeat } = await import("./health-route.mjs");
    const now = Date.now();
    await recordHeartbeat(env, { go_heartbeat_ms: now, stream_lag_ms: 0, redis_reachable: true });

    for (let i = 0; i < 3; i++) {
      await pollOnce(env, {
        nowMs: now + i * 5_000, mode: "DEGRADED", store: d1Store(env), symbols: ["BTCUSDT", "ETHUSDT"],
        jitter: () => 0, get: priceGet(),
      });
    }
    assert.equal(scalar("SELECT COUNT(*) FROM health_snapshots WHERE id='poll_quotes';"), 1);
    const status = await pollStatus(env, now + 10_000);
    assert.equal(status.drained, true);
    assert.equal(status.symbols, 2);
    assert.equal(status.covered, 2);
    assert.equal(status.rounds, 3);
    assert.equal(status.quote_lag_ms, 0);
  });

  it("a partially answered round keeps freshness ageing (R-STALE, §6.2 S5)", async () => {
    const env = freshEnv();
    const { tick: pollOnce, d1Store, pollStatus } = await import("./fallback-poll.mjs");
    const now = Date.now();
    const store = d1Store(env);

    const full = await pollOnce(env, {
      nowMs: now, mode: "DEGRADED", store, symbols: ["BTCUSDT", "ETHUSDT"], jitter: () => 0, get: priceGet(),
    });
    assert.equal(full.reason, "ok");
    assert.equal((await pollStatus(env, now)).quote_lag_ms, 0);

    const partial = await pollOnce(env, {
      nowMs: now + 5_000, mode: "DEGRADED", store, symbols: ["BTCUSDT", "ETHUSDT"],
      jitter: () => 0, get: priceGet(["ETHUSDT"]),
    });
    assert.equal(partial.reason, "partial-quotes");
    assert.equal(partial.covered, 1);
    const status = await pollStatus(env, now + 5_000);
    assert.equal(status.newest_at_ms, now); // the earlier snapshot, not the partial round
    assert.equal(status.quote_lag_ms, 5_000); // it aged rather than refreshed
  });

  it("in fallback the poller's snapshot age is the price freshness (§6.2 S1)", async () => {
    const env = freshEnv();
    const { assembleSignals, recordHeartbeat } = await import("./health-route.mjs");
    const { d1Store, tick: pollOnce } = await import("./fallback-poll.mjs");
    const { evaluate } = await import("./health.mjs");
    const now = Date.now();
    // degraded + Go silent → the fallback path is engaged
    await recordHeartbeat(env, { go_heartbeat_ms: now - 30_000, stream_lag_ms: 0, redis_reachable: true });
    sql(`INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('hs_prev','mode','DEGRADED','{}','${new Date(now - 30_000).toISOString()}');`);

    // no fallback quote yet → stale by definition, never fresh
    const before = evaluate(await assembleSignals(env, now));
    assert.equal(before.mode, "FALLBACK");
    assert.ok(before.reasons.some((r) => r.startsWith("price_stale=")));

    // after one poll the fallback snapshot is fresh enough to be usable
    await pollOnce(env, {
      nowMs: now, mode: "FALLBACK", store: d1Store(env), symbols: ["BTCUSDT"], jitter: () => 0,
      // the live futures endpoint echoes the requested (venue) form
      get: async (url) => ({ status: 200, body: [{ s: new URL(url).searchParams.get("symbol"), p: "1" }] }),
    });
    const after = evaluate(await assembleSignals(env, now + 1_000));
    assert.equal(after.components.find((c) => c.component === "prices").status, "FRESH");
  });

  it("runCron drives the poller while degraded and feeds the drained counter", async () => {
    const env = freshEnv();
    const { runCron } = await import("./index.mjs");
    const { recordHeartbeat, handoffLease } = await import("./health-route.mjs");
    const now = Date.now();
    await recordHeartbeat(env, { go_heartbeat_ms: now - 30_000, stream_lag_ms: 0, redis_reachable: true });
    await handoffLease(env, { holder: HOLDERS.PRIMARY, nowMs: now });

    const res = await runCron(env, {
      nowMs: now, symbols: ["BTCUSDT"],
      get: async (url) => ({ status: 200, body: [{ s: new URL(url).searchParams.get("symbol"), p: "1" }] }),
    });
    assert.equal(res.poll.round, "ok");
    assert.equal(res.poll.drained, true);
    assert.equal(res.rejoin.fallback_inflight, 0); // drained → §6.3 condition 3 satisfied
    assert.equal(scalar("SELECT COUNT(*) FROM health_snapshots WHERE id='poll_quotes';"), 1);
  });
});