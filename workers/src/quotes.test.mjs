// quotes.test.mjs — /api/prices: filtered + full venue reads, budget, fail-soft.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { listPrices, resetFullCache, resetSnapshotThrottle, resetVenueBlock, MAX_FILTERED, SNAPSHOT_WRITE_MS, VENUE_BLOCK_MS } from "./quotes.mjs";
import { createWindow, REST_BASE } from "./fallback-poll.mjs";

const url = (q = "") => new URL(`https://worker.dev/api/prices${q}`);
const freshWindow = () => createWindow({ budget: 3000 });
const res = (status, list) => ({ status, text: async () => JSON.stringify(list) });

describe("quotes — filtered mode", () => {
  beforeEach(() => { resetFullCache(); resetVenueBlock(); });

  it("sends the venue (dash) form and canonicalises the answer", async () => {
    const seen = [];
    const fetchFn = async (u) => {
      const ustr = String(u);
      seen.push(ustr);
      const sym = decodeURIComponent(ustr.split("symbol=")[1] ?? "");
      return res(200, sym === "TAG-SWAP-USDT" ? [{ s: "TAG-SWAP-USDT", p: "0.0006359" }] : [{ s: "BTC-SWAP-USDT", p: "83838" }]);
    };
    const r = await listPrices({}, { url: url("?symbols=TAGUSDT,BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.match(seen[0], /symbol=TAG-SWAP-USDT$/);
    assert.match(seen[1], /symbol=BTC-SWAP-USDT$/);
    assert.equal(r.mode, "filtered");
    assert.equal(r.prices.TAGUSDT, "0.0006359");
    assert.deepEqual(r.missing, []);
  });

  it("refuses the spot echo and reports the symbol missing (venueForm guard)", async () => {
    const fetchFn = async () => res(200, [{ s: "TAGUSDT", p: "0.000635" }]); // canonical echo = spot
    const r = await listPrices({}, { url: url("?symbols=TAGUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.deepEqual(Object.keys(r.prices), []);
    assert.deepEqual(r.missing, ["TAGUSDT"]);
  });

  it("never throws for data reasons: transport failure lands in missing[]", async () => {
    const fetchFn = async () => { throw new Error("boom"); };
    const r = await listPrices({}, { url: url("?symbols=TAGUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.deepEqual(r.missing, ["TAGUSDT"]);
  });

  it("rejects a bad symbol and an over-large list with VALIDATION", async () => {
    await assert.rejects(
      listPrices({}, { url: url("?symbols=TAG-X"), fetchFn: async () => res(200, []), nowMs: 1_000, window: freshWindow() }),
      (e) => e.code === "VALIDATION",
    );
    const many = Array.from({ length: MAX_FILTERED + 1 }, (_, i) => `A${i}USDT`).join(",");
    await assert.rejects(
      listPrices({}, { url: url(`?symbols=${many}`), fetchFn: async () => res(200, []), nowMs: 1_000, window: freshWindow() }),
      (e) => e.code === "VALIDATION",
    );
  });

  it("spends the shared ADR-004 window (1 weight per symbol) and fails closed on budget", async () => {
    const win = freshWindow();
    const fetchFn = async () => res(200, [{ s: "BTC-SWAP-USDT", p: "1" }]);
    await listPrices({}, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: win });
    assert.equal(win.usage(1_000), 1);
    const empty = createWindow({ budget: 0 });
    await assert.rejects(
      listPrices({}, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: empty }),
      (e) => e.code === "RATE",
    );
  });
});

describe("quotes — full mode", () => {
  beforeEach(() => { resetFullCache(); resetVenueBlock(); });

  it("answers the whole venue from ONE unfiltered weight-1 request, then serves the 5s cache", async () => {
    let calls = 0;
    const seen = [];
    const fetchFn = async (u) => {
      calls++;
      seen.push(String(u));
      return res(200, [{ s: "TAG-SWAP-USDT", p: "0.0006359" }, { s: "BTCUSDT", p: "1" }, { p: "2" }]);
    };
    const r1 = await listPrices({}, { url: url(), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.equal(calls, 1);
    assert.match(seen[0], /\/quote\/v1\/contract\/ticker\/price$/);
    assert.equal(r1.mode, "full");
    assert.equal(r1.prices.TAGUSDT, "0.0006359"); // canonicalised
    assert.equal(r1.prices.BTCUSDT, undefined);   // spot row refused by the venueForm guard
    assert.equal(r1.stale, false);
    const r2 = await listPrices({}, { url: url(), fetchFn, nowMs: 1_000 + 4_999, window: freshWindow() });
    assert.equal(calls, 1); // cache hit
    assert.equal(r2.cached, true);
  });

  it("serves the stale cache when the venue fails, DEGRADED when there is none", async () => {
    const good = async () => res(200, [{ s: "BTC-SWAP-USDT", p: "83838" }]);
    await listPrices({}, { url: url(), fetchFn: good, nowMs: 1_000, window: freshWindow() });
    const bad = async () => { throw new Error("venue down"); };
    const r = await listPrices({}, { url: url(), fetchFn: bad, nowMs: 10_000, window: freshWindow() });
    assert.equal(r.stale, true);
    assert.equal(r.prices.BTCUSDT, "83838");
    resetFullCache();
    await assert.rejects(
      listPrices({}, { url: url(), fetchFn: bad, nowMs: 10_000, window: freshWindow() }),
      (e) => e.code === "DEGRADED",
    );
  });

  it("a non-200 venue answer is not cached as fresh data", async () => {
    const fetchFn = async () => ({ status: 503, text: async () => "" });
    await assert.rejects(
      listPrices({}, { url: url(), fetchFn, nowMs: 1_000, window: freshWindow() }),
      (e) => e.code === "DEGRADED",
    );
  });
});


// ── D1 last-known-price fallback (ADR-004, 2026-11-07 venue 403) ─────────────
// A fake D1 that keeps price_snapshots rows in a Map, so the fallback's write
// and read paths are exercised for real instead of mocked at the call site.
function snapshotDb(seed = {}) {
  const rows = new Map(Object.entries(seed));
  const writes = [];
  return {
    rows,
    writes,
    prepare(sql) {
      return {
        _sql: sql,
        _args: [],
        bind(...a) { this._args = a; return this; },
        async run() { writes.push({ sql, args: this._args }); return {}; },
        async all() {
          if (!/FROM price_snapshots/i.test(sql)) return { results: [] };
          const out = this._args
            .map((s) => (rows.has(s) ? { symbol: s, px: rows.get(s).px, at: rows.get(s).at } : null))
            .filter(Boolean);
          return { results: out };
        },
      };
    },
    async batch(list) { for (const s of list) await s.run(); },
  };
}

describe("quotes — D1 last-known-price fallback", () => {
  beforeEach(() => { resetFullCache(); resetSnapshotThrottle(); resetVenueBlock(); });

  it("records a live price so the NEXT blocked request can answer", async () => {
    const DB = snapshotDb();
    const fetchFn = async () => res(200, [{ s: "BTC-SWAP-USDT", p: "83838" }]);
    const r = await listPrices({ DB }, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.equal(r.prices.BTCUSDT, "83838");
    assert.equal(r.source, "venue");
    assert.equal(r.stale, false);
    assert.equal(DB.writes.length, 1, "one upsert for the live price");
    assert.match(DB.writes[0].sql, /INSERT INTO price_snapshots/);
    assert.deepEqual(DB.writes[0].args.slice(0, 2), ["BTCUSDT", "83838"]);
  });

  it("serves the D1 snapshot as STALE when the venue blocks, and clears it from missing[]", async () => {
    const DB = snapshotDb({ BTCUSDT: { px: "80000", at: "2026-11-07T20:00:00.000Z" } });
    const fetchFn = async () => res(403, []); // the Toobit-to-Cloudflare answer
    const r = await listPrices({ DB }, {
      url: url("?symbols=BTCUSDT,ETHUSDT"), fetchFn,
      nowMs: Date.parse("2026-11-07T21:00:00Z"), window: freshWindow(),
    });
    assert.equal(r.prices.BTCUSDT, "80000");
    assert.deepEqual(r.stale_symbols, ["BTCUSDT"]);
    assert.equal(r.stale, true);
    assert.equal(r.source, "d1");
    // ETHUSDT has never been seen: it stays honestly missing, never invented.
    assert.deepEqual(r.missing, ["ETHUSDT"]);
    assert.equal(r.prices.ETHUSDT, undefined);
  });

  it("throttles the snapshot write so polling cannot become a write storm", async () => {
    const DB = snapshotDb();
    const fetchFn = async () => res(200, [{ s: "BTC-SWAP-USDT", p: "83838" }]);
    await listPrices({ DB }, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    await listPrices({ DB }, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000 + SNAPSHOT_WRITE_MS - 1, window: freshWindow() });
    assert.equal(DB.writes.length, 1, "second read inside the window must not write");
    await listPrices({ DB }, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000 + SNAPSHOT_WRITE_MS, window: freshWindow() });
    assert.equal(DB.writes.length, 2, "after the window it writes again");
  });

  it("no DB binding is no fallback, never a crash", async () => {
    const fetchFn = async () => res(403, []);
    const r = await listPrices({}, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.deepEqual(r.missing, ["BTCUSDT"]);
    assert.deepEqual(r.prices, {});
  });
});

// ── second egress (2026-11-08) ───────────────────────────────────────────────
// The reported symptom: "the price isn't there at all". Toobit answers HTTP 403
// to Cloudflare's egress while answering the Go plane (verified live: the Go
// /analyze returned data_source "toobit-rest"), and D1 had never observed a
// price either — so `prices` came back EMPTY and the desk had no number. The
// venue stays first; only the symbols it refused travel over the bridge.
describe("quotes — Go-plane gap fill when the venue blocks Cloudflare", () => {
  beforeEach(() => { resetFullCache(); resetSnapshotThrottle(); resetVenueBlock(); });

  const bridgeEnv = () => ({ GO_WATCHER_URL: "https://go.example" });

  /** fetchFn that 403s every venue read and answers the Go plane. */
  const venueBlocked = (prices, missing = []) => async (u) => {
    const s = String(u);
    if (s.startsWith("https://go.example/api/market/prices")) {
      return { status: 200, text: async () => JSON.stringify({ at: 1, prices, missing }) };
    }
    return res(403, []); // the Toobit → Cloudflare answer
  };

  it("fills the blocked symbol from the Go plane and labels the egress", async () => {
    const fetchFn = venueBlocked([{ symbol: "BTCUSDT", px: "75894.1", src: "toobit-rest" }]);
    const r = await listPrices(bridgeEnv(), { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.equal(r.prices.BTCUSDT, "75894.1");
    assert.equal(r.source, "go-watcher");
    assert.equal(r.stale, false, "the Go plane read the SAME venue live — not a cached number");
    assert.deepEqual(r.bridged_symbols, ["BTCUSDT"]);
    assert.deepEqual(r.missing, []);
    assert.equal(r.degraded, undefined, "a price we actually have is not degraded");
  });

  it("records the bridged price in D1, so the NEXT blackout still has a number", async () => {
    const DB = snapshotDb();
    const fetchFn = venueBlocked([{ symbol: "BTCUSDT", px: "75894.1", src: "toobit-rest" }]);
    const r = await listPrices({ DB, ...bridgeEnv() }, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.equal(r.prices.BTCUSDT, "75894.1");
    assert.equal(DB.writes.length, 1);
    assert.deepEqual(DB.writes[0].args.slice(0, 3), ["BTCUSDT", "75894.1", "go-watcher"]);
  });

  it("D1 stays the last line when the Go plane cannot answer either", async () => {
    // Both egresses fail for BTCUSDT: the snapshot is served, labelled stale.
    const DB = snapshotDb({ BTCUSDT: { px: "80000", at: "2026-11-07T20:00:00.000Z" } });
    const fetchFn = async (u) => (String(u).startsWith("https://go.example")
      ? { status: 200, text: async () => JSON.stringify({ prices: [], missing: ["BTCUSDT"] }) }
      : res(403, []));
    const r = await listPrices({ DB, ...bridgeEnv() }, {
      url: url("?symbols=BTCUSDT"), fetchFn,
      nowMs: Date.parse("2026-11-07T21:00:00Z"), window: freshWindow(),
    });
    assert.equal(r.prices.BTCUSDT, "80000");
    assert.equal(r.source, "d1");
    assert.equal(r.stale, true);
    assert.deepEqual(r.stale_symbols, ["BTCUSDT"]);
  });

  it("nothing answers: the symbol stays missing and degraded says WHY", async () => {
    const fetchFn = async (u) => (String(u).startsWith("https://go.example")
      ? res(502, { code: "MARKET_UNAVAILABLE" })
      : res(403, []));
    const r = await listPrices(bridgeEnv(), { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.deepEqual(r.prices, {});
    assert.deepEqual(r.missing, ["BTCUSDT"]);
    assert.match(r.degraded, /403/, "a blocked venue must be explainable, never a silent empty object");
  });

  it("keeps the venue's answer for a symbol the bridge also reports", async () => {
    // The venue is NOT blocked here: the bridge must not be consulted at all.
    let bridged = 0;
    const fetchFn = async (u) => {
      if (String(u).startsWith("https://go.example")) { bridged++; return res(200, { prices: [] }); }
      return res(200, [{ s: "BTC-SWAP-USDT", p: "83838" }]);
    };
    const r = await listPrices({ ...bridgeEnv() }, { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    assert.equal(r.prices.BTCUSDT, "83838");
    assert.equal(r.source, "venue");
    assert.equal(bridged, 0);
  });

  // A 25-symbol cockpit tick used to spend ~8.5s collecting 25 identical 403s
  // before the bridge was even asked — most of the desk's 15s budget burned on an
  // answer we already had. The breaker skips a venue that just refused us, and
  // still re-tries it once per VENUE_BLOCK_MS so recovery stays automatic.
  it("stops asking a venue that just refused it — and tries again later", async () => {
    resetVenueBlock();
    const venueCalls = () => calls.filter((c) => c.includes("api.toobit.com")).length;
    const calls = [];
    const fetchFn = async (u) => {
      const s = String(u);
      calls.push(s);
      if (s.startsWith("https://go.example")) {
        return { status: 200, text: async () => JSON.stringify({ prices: [{ symbol: "BTCUSDT", px: "1" }] }) };
      }
      return res(403, []); // the Toobit → Cloudflare answer
    };
    const win = freshWindow();
    const first = await listPrices(bridgeEnv(), { url: url("?symbols=BTCUSDT,ETHUSDT"), fetchFn, nowMs: 1_000, window: win });
    assert.equal(venueCalls(), 2, "the first tick does try the venue, per symbol");
    assert.equal(first.prices.BTCUSDT, "1");

    // Inside the block window the venue is not asked at all — not once per symbol.
    const before = venueCalls();
    const second = await listPrices(bridgeEnv(), { url: url("?symbols=BTCUSDT,ETHUSDT"), fetchFn, nowMs: 2_000, window: win });
    assert.equal(venueCalls(), before, "a blocked venue must not be re-asked for every symbol");
    assert.equal(second.prices.BTCUSDT, "1", "the bridge still answers");
    assert.equal(win.usage(2_000), 2, "nothing is spent on a venue we did not call");

    // After the window it tries again by itself — no manual reset, ever.
    await listPrices(bridgeEnv(), { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 2_000 + VENUE_BLOCK_MS, window: win });
    assert.equal(venueCalls(), before + 1, "the window expires into one fresh attempt");
  });

  it("a transport error must NOT trip the breaker (it may be a blip)", async () => {
    resetVenueBlock();
    let venueCalls = 0;
    const fetchFn = async (u) => {
      if (String(u).startsWith("https://go.example")) {
        return { status: 200, text: async () => JSON.stringify({ prices: [{ symbol: "BTCUSDT", px: "1" }] }) };
      }
      venueCalls++;
      throw new Error("socket hang up");
    };
    await listPrices(bridgeEnv(), { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_000, window: freshWindow() });
    await listPrices(bridgeEnv(), { url: url("?symbols=BTCUSDT"), fetchFn, nowMs: 1_500, window: freshWindow() });
    assert.equal(venueCalls, 2, "a thrown transport error is retried on the next tick");
  });
});
