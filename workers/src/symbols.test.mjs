// symbols.test.mjs — Toobit-backed symbol list: canonicalisation, cache, fail-soft.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalSymbol, parseSymbols, listSymbols, SYMBOLS_TTL_MS } from "./symbols.mjs";

const memDb = (configJson) => ({
  prepare() {
    return { all: async () => ({ results: configJson ? [{ config_json: configJson }] : [] }) };
  },
});

const kvStore = () => {
  let raw = null;
  return { get: async () => raw, put: async (k, v) => { raw = v; } };
};

const freshEnv = (configJson) => ({ DB: memDb(configJson), TOOBIT_BASE: "https://x", SYMBOLS_KV: kvStore() });

describe("symbols", () => {
  it("canonicalises the venue dash form", () => {
    assert.equal(canonicalSymbol("BTC-SWAP-USDT"), "BTCUSDT");
    assert.equal(canonicalSymbol("ETH-SWAP-USDT"), "ETHUSDT");
    assert.equal(canonicalSymbol("BTCUSDT"), "BTCUSDT");
  });

  it("parses + dedupes the raw venue list, and rejects a spot (canonical) echo", () => {
    const body = [
      { s: "BTC-SWAP-USDT", p: "67000" },
      { s: "BTCUSDT", p: "67001" }, // spot echo: dropped, not a futures market
      { s: "ETH-SWAP-USDT", p: "3500" },
      { s: "nope", p: "1" },
      { p: "2" },
    ];
    assert.deepEqual(parseSymbols(body), ["BTCUSDT", "ETHUSDT"]);
    // A list that only carries canonical (spot) rows is not a futures universe.
    assert.deepEqual(parseSymbols([{ s: "EDUUSDT", p: "0.0586" }]), []);
    // USDC-margined contracts are out of scope (USDT-M only).
    assert.deepEqual(parseSymbols([{ s: "DOGE-SWAP-USDC", p: "0.2" }]), []);
  });

  it("fetches once then serves cache within TTL", async () => {
    let calls = 0;
    const fetchFn = async () => ({ ok: true, json: async () => [{ s: "SOL-SWAP-USDT", p: "170" }] });
    const env = freshEnv(JSON.stringify({ allowlist: ["SOLUSDT"] }));
    const r1 = await listSymbols(env, { fetchFn, nowMs: 1_000 });
    assert.deepEqual(r1.symbols, ["SOLUSDT"]);
    assert.deepEqual(r1.allowlist, ["SOLUSDT"]);
    assert.equal(r1.stale, false);
    const r2 = await listSymbols(env, { fetchFn: async () => { calls++; throw new Error("must not fetch"); }, nowMs: 1_000 + SYMBOLS_TTL_MS - 1 });
    assert.deepEqual(r2.symbols, ["SOLUSDT"]);
    assert.equal(calls, 0);
  });

  it("goes stale-soft after TTL when the venue fails", async () => {
    const env = freshEnv(null);
    const good = async () => ({ ok: true, json: async () => [{ s: "BTC-SWAP-USDT", p: "1" }] });
    await listSymbols(env, { fetchFn: good, nowMs: 5_000 });
    const bad = async () => { throw new Error("venue down"); };
    const r = await listSymbols(env, { fetchFn: bad, nowMs: 5_000 + SYMBOLS_TTL_MS + 1 });
    assert.equal(r.stale, true);
    assert.deepEqual(r.symbols, ["BTCUSDT"]);
  });

  it("venue block with no cache answers FROM D1, not a 503 (2026-11-07 Toobit 403)", async () => {
    // A fake D1 that answers each table with its own rows, so the fallback's
    // three sources (allowlist, watches, positions) are exercised for real.
    const db = {
      prepare(sql) {
        return {
          all: async () => {
            if (sql.includes("strategy_configs")) {
              return { results: [{ config_json: JSON.stringify({ allowlist: ["BTCUSDT"] }) }] };
            }
            if (sql.includes("watches")) return { results: [{ symbol: "ETHUSDT" }] };
            if (sql.includes("positions")) return { results: [{ symbol: "SOLUSDT" }] };
            return { results: [] };
          },
        };
      },
    };
    // SYMBOLS_KV.get() -> null forces a COLD start: readCache() answers from KV
    // when the binding exists, so the module-level memory cache left by the
    // earlier tests cannot mask the venue failure here.
    const env = { DB: db, TOOBIT_BASE: "https://x", SYMBOLS_KV: { get: async () => null, put: async () => {} } };
    const r = await listSymbols(env, {
      fetchFn: async () => { throw new Error("venue HTTP 403"); },
      nowMs: 9_000,
    });
    // Every symbol the platform knows, sorted — the picker stays usable.
    assert.deepEqual(r.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    assert.deepEqual(r.allowlist, ["BTCUSDT"]);
    assert.equal(r.stale, true);
    assert.equal(r.source, "d1");
    assert.match(r.degraded, /403/);
  });

  it("a total miss still answers 200-shaped with an explicit reason, never throws", async () => {
    const env = freshEnv(null);
    const r = await listSymbols(env, {
      fetchFn: async () => { throw new Error("down"); }, nowMs: 9_000 + SYMBOLS_TTL_MS + 1,
    });
    assert.deepEqual(r.symbols, []);
    assert.equal(r.stale, true);
    assert.match(r.degraded, /venue unavailable/);
  });

  // ── second egress (2026-11-08) ─────────────────────────────────────────────
  // The reported symptom: "I search and nothing but these few coins comes up".
  // Toobit 403s Cloudflare's egress while answering the Go plane, so the picker
  // had collapsed onto D1's allowlist + watched symbols (four rows). The Go leg
  // answers the SAME venue read, so the catalog is full again — and live, which
  // is why it is NOT flagged stale.
  it("venue 403 + the Go plane answers → the FULL catalog, live, not D1's four rows", async () => {
    const env = {
      DB: memDb(JSON.stringify({ allowlist: ["BTCUSDT"] })),
      TOOBIT_BASE: "https://venue.example",
      SYMBOLS_KV: kvStore(),
      GO_WATCHER_URL: "https://go.example",
    };
    const seen = [];
    const fetchFn = async (u) => {
      const s = String(u);
      seen.push(s);
      if (s.startsWith("https://go.example/api/market/symbols")) {
        // The venue lists 1INCHUSDT; the repo-wide SYMBOL_RE refuses it, so the
        // bridge must not widen the universe just because the egress changed.
        return {
          ok: true, status: 200,
          json: async () => ({ symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "1INCHUSDT", "BTCUSDT"], source: "toobit-rest" }),
          text: async () => JSON.stringify({ symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "1INCHUSDT", "BTCUSDT"] }),
        };
      }
      return { ok: false, status: 403, json: async () => ({}), text: async () => "" }; // Toobit → Cloudflare
    };
    const r = await listSymbols(env, { fetchFn, nowMs: 5_000 });
    assert.deepEqual(r.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]);
    assert.deepEqual(r.allowlist, ["BTCUSDT"]);
    assert.equal(r.source, "go-watcher");
    assert.equal(r.stale, false, "a live venue read is not a stale cache");
    assert.match(seen[0], /^https:\/\/venue\.example/);
    assert.match(seen[1], /^https:\/\/go\.example\/api\/market\/symbols$/);

    // The bridged catalog caches like a venue success: one round-trip per TTL.
    const r2 = await listSymbols(env, {
      fetchFn: async () => { throw new Error("must not fetch inside the TTL"); },
      nowMs: 5_000 + SYMBOLS_TTL_MS - 1,
    });
    assert.deepEqual(r2.symbols, r.symbols);
    assert.equal(r2.stale, false);
  });

  it("both egresses blocked still answers from D1, and says so", async () => {
    const db = {
      prepare(sql) {
        return {
          all: async () => (sql.includes("strategy_configs")
            ? { results: [{ config_json: JSON.stringify({ allowlist: ["BTCUSDT"] }) }] }
            : { results: [] }),
        };
      },
    };
    const env = { DB: db, TOOBIT_BASE: "https://venue.example", SYMBOLS_KV: kvStore(), GO_WATCHER_URL: "https://go.example" };
    const r = await listSymbols(env, {
      fetchFn: async () => { throw new Error("venue HTTP 403"); },
      nowMs: 7_000,
    });
    assert.deepEqual(r.symbols, ["BTCUSDT"]);
    assert.equal(r.source, "d1");
    assert.equal(r.stale, true);
    assert.match(r.degraded, /403/);
  });
});
