// quotes.test.mjs — /api/prices: filtered + full venue reads, budget, fail-soft.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { listPrices, resetFullCache, resetSnapshotThrottle, MAX_FILTERED, SNAPSHOT_WRITE_MS } from "./quotes.mjs";
import { createWindow, REST_BASE } from "./fallback-poll.mjs";

const url = (q = "") => new URL(`https://worker.dev/api/prices${q}`);
const freshWindow = () => createWindow({ budget: 3000 });
const res = (status, list) => ({ status, text: async () => JSON.stringify(list) });

describe("quotes — filtered mode", () => {
  beforeEach(resetFullCache);

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
  beforeEach(resetFullCache);

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
  beforeEach(() => { resetFullCache(); resetSnapshotThrottle(); });

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
