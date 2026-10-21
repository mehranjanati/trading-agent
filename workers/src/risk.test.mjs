// risk.test.mjs — E08-T01-S2: the 8-code reject matrix (node:test, stdlib).
// Pure module: no DB, no network. Every code gets a red path (100% reject
// coverage is an acceptance criterion), boundaries are proven with exact
// decimal math, and the fixed evaluation order is asserted by peeling.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RISK_CODES, validate, limitsFrom, mulDec, addDec, cmpDec, normDec } from "./risk.mjs";

const LIMITS = {
  max_leverage: 5, max_notional_usd: "1000", max_exposure_usd: "5000",
  allowlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], stale_s_seconds: 5,
  max_active_watches: 5, max_active_watches_per_symbol: 2,
};
const NOW = 1_800_000_000_000;
const INTENT = { approval_id: "a1", side: "BUY", qty: "1", leverage: 5 };
/** A context that passes every gate; tests break exactly one thing at a time. */
const okCtx = (over = {}) => ({
  now_ms: NOW, limits: LIMITS, limits_version: "v1-paper",
  kill: { engaged: false },
  approval: { decision: "approve", used_at: null, expires_at: new Date(NOW + 600_000).toISOString() },
  watch: { id: "w1", symbol: "BTCUSDT", direction: "LONG" },
  price: { px: "100", at_ms: NOW - 1000 },
  exposure: { open_notional_usd: "0" },
  active_watches: 0, active_watches_for_symbol: 0,
  live_intent_for_approval: false,
  ...over,
});

describe("E08-T01 exact decimal math (money is strings, never floats)", () => {
  it("mul/add/cmp are exact where floats drift", () => {
    assert.equal(mulDec("0.1", "0.7"), "0.07"); // float gives 0.07000000000000001
    assert.equal(addDec("0.1", "0.2"), "0.3");  // float gives 0.30000000000000004
    assert.equal(mulDec("0.3", "0.1"), "0.03");
    assert.equal(cmpDec("0.3", "0.30"), 0);     // scale-insensitive equality
    assert.equal(cmpDec("0.30", "0.3"), 0);
    assert.equal(cmpDec("0.301", "0.3"), 1);
    assert.equal(cmpDec("0.29", "0.3"), -1);
    assert.equal(normDec("0010.5000"), "10.5");
  });
  it("a boundary that floats would reject passes exactly", () => {
    const L = { ...LIMITS, max_notional_usd: "0.07" };
    const ctx = okCtx({ limits: L, price: { px: "0.7", at_ms: NOW - 1000 } });
    const r = validate({ approval_id: "a1", side: "BUY", qty: "0.1", leverage: 5 }, ctx);
    assert.equal(r.ok, true); // 0.1 * 0.7 == 0.07 exactly; Number math would say >
  });
});

describe("E08-T01 limitsFrom (versioned, fail-closed config)", () => {
  it("normalises a full config and keeps the version for audit", () => {
    const L = limitsFrom(LIMITS, "v1-paper");
    assert.deepEqual(L, LIMITS);
  });
  for (const missing of ["max_leverage", "max_notional_usd", "max_exposure_usd", "allowlist", "stale_s_seconds"]) {
    it(`missing ${missing} throws DEGRADED (never invents a default)`, () => {
      const bad = { ...LIMITS }; delete bad[missing];
      assert.throws(() => limitsFrom(bad, "v1-paper"), (e) => e.code === "DEGRADED");
    });
  }
  it("validate() without limits throws DEGRADED (fail closed)", () => {
    assert.throws(() => validate(INTENT, okCtx({ limits: undefined })), (e) => e.code === "DEGRADED");
  });
  it("validate() without a ctx at all throws DEGRADED", () => {
    assert.throws(() => validate(INTENT), (e) => e.code === "DEGRADED");
  });
});
describe("E08-T01 the 8-code reject matrix (fixed order, first failure wins)", () => {
  it("PASS carries the limits version that judged it", () => {
    assert.deepEqual(validate(INTENT, okCtx()), { ok: true, code: "PASS", limits_version: "v1-paper" });
  });

  // --- R-KILL ---------------------------------------------------------------
  it("R-KILL: engaged → halt detail carries actor+reason", () => {
    const r = validate(INTENT, okCtx({ kill: { engaged: true, actor: "operator", reason: "game-day" } }));
    assert.equal(r.code, "R-KILL");
    assert.equal(r.detail.engaged, true);
    assert.equal(r.detail.actor, "operator");
  });
  it("R-KILL: missing kill state fails closed (unknown == engaged)", () => {
    const ctx = okCtx(); delete ctx.kill;
    assert.equal(validate(INTENT, ctx).code, "R-KILL");
  });
  it("R-KILL: kill.engaged true-ish garbage fails closed", () => {
    for (const engaged of [undefined, null, 1, "no", true]) {
      assert.equal(validate(INTENT, okCtx({ kill: { engaged } })).code, "R-KILL", String(engaged));
    }
  });

  // --- R-APPROVAL -----------------------------------------------------------
  it("R-APPROVAL: missing approval", () => {
    const r = validate(INTENT, okCtx({ approval: null }));
    assert.equal(r.code, "R-APPROVAL");
    assert.equal(r.detail.approval_id, "a1");
  });
  it("R-APPROVAL: decision not granted", () => {
    assert.equal(validate(INTENT, okCtx({ approval: { decision: "reject", used_at: null, expires_at: new Date(NOW + 1).toISOString() } })).code, "R-APPROVAL");
  });
  it("R-APPROVAL: already consumed (single-use, SAFE-002)", () => {
    const a = { decision: "approve", used_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + 600_000).toISOString() };
    const r = validate(INTENT, okCtx({ approval: a }));
    assert.equal(r.code, "R-APPROVAL");
    assert.equal(r.detail.used_at, a.used_at);
  });
  it("R-APPROVAL: expired at the boundary (now >= expires_at)", () => {
    const r = validate(INTENT, okCtx({ approval: { decision: "approve", used_at: null, expires_at: new Date(NOW).toISOString() } }));
    assert.equal(r.code, "R-APPROVAL");
  });
  it("R-APPROVAL: unreadable expiry fails closed", () => {
    assert.equal(validate(INTENT, okCtx({ approval: { decision: "approve", used_at: null, expires_at: "soon" } })).code, "R-APPROVAL");
  });

  // --- R-SYM ----------------------------------------------------------------
  it("R-SYM: unlisted symbol → reject + suggest allowlist", () => {
    const r = validate(INTENT, okCtx({ watch: { id: "w2", symbol: "DOGEUSDT", direction: "LONG" } }));
    assert.equal(r.code, "R-SYM");
    assert.equal(r.detail.symbol, "DOGEUSDT");
    assert.deepEqual(r.detail.suggest, LIMITS.allowlist);
  });
  it("R-SYM: unknown symbol (no watch) fails closed", () => {
    assert.equal(validate(INTENT, okCtx({ watch: null })).code, "R-SYM");
  });

  // --- R-LEV ----------------------------------------------------------------
  it("R-LEV: over leverage → limit + asked (J3)", () => {
    const r = validate({ ...INTENT, leverage: 6 }, okCtx());
    assert.equal(r.code, "R-LEV");
    assert.deepEqual(r.detail, { limit: 5, asked: 6 });
  });
  it("R-LEV: invalid leverage (0, non-integer, missing) fails closed", () => {
    for (const leverage of [0, -1, 5.5, undefined]) {
      assert.equal(validate({ ...INTENT, leverage }, okCtx()).code, "R-LEV", String(leverage));
    }
  });

  // --- R-NOT ----------------------------------------------------------------
  it("R-NOT: notional over cap → limit + asked", () => {
    const r = validate({ ...INTENT, qty: "11" }, okCtx()); // 11 * 100 = 1100 > 1000
    assert.equal(r.code, "R-NOT");
    assert.deepEqual(r.detail, { limit: "1000", asked: "1100" });
  });
  it("R-NOT: unparseable qty/price fails closed (not computable)", () => {
    assert.equal(validate({ ...INTENT, qty: "1.0e3" }, okCtx()).code, "R-NOT");
    assert.equal(validate(INTENT, okCtx({ price: { px: "abc", at_ms: NOW } })).code, "R-NOT");
    assert.equal(validate({ ...INTENT, qty: undefined }, okCtx()).code, "R-NOT");
  });

  // --- R-EXP ----------------------------------------------------------------
  it("R-EXP: boundary under cap passes; over cap → limit/open/asked", () => {
    const under = validate(INTENT, okCtx({ exposure: { open_notional_usd: "4900" } })); // 4900+100 = 5000 == cap
    assert.equal(under.ok, true);
    const r = validate({ ...INTENT, qty: "10" }, okCtx({ exposure: { open_notional_usd: "4500" } })); // 4500+1000
    assert.equal(r.code, "R-EXP");
    assert.deepEqual(r.detail, { limit: "5000", open: "4500", asked: "5500" });
  });
  it("R-EXP: unknown open exposure fails closed", () => {
    assert.equal(validate(INTENT, okCtx({ exposure: null })).code, "R-EXP");
    assert.equal(validate(INTENT, okCtx({ exposure: {} })).code, "R-EXP");
  });

  // --- R-SLOT ---------------------------------------------------------------
  it("R-SLOT: the global active-watch cap rejects with limit + active", () => {
    const r = validate(INTENT, okCtx({ active_watches: 5 })); // cap 5 → 5 >= 5
    assert.equal(r.code, "R-SLOT");
    assert.equal(r.detail.limit, 5);
    assert.equal(r.detail.active, 5);
  });
  it("R-SLOT: the per-symbol cap is checked independently of the global one", () => {
    const r = validate(INTENT, okCtx({ active_watches: 0, active_watches_for_symbol: 2 })); // cap 2
    assert.equal(r.code, "R-SLOT");
    assert.equal(r.detail.limit, 2);
    assert.equal(r.detail.symbol, "BTCUSDT");
  });
  it("R-SLOT: an unknown count fails closed (SAFE-001)", () => {
    assert.equal(validate(INTENT, okCtx({ active_watches: null })).code, "R-SLOT");
    assert.equal(validate(INTENT, okCtx({ active_watches: undefined })).code, "R-SLOT");
    assert.equal(validate(INTENT, okCtx({ active_watches_for_symbol: null })).code, "R-SLOT");
  });
  it("R-SLOT: a config WITHOUT the caps skips the gate (no invented limit)", () => {
    const L = { ...LIMITS };
    delete L.max_active_watches;
    delete L.max_active_watches_per_symbol;
    const r = validate(INTENT, okCtx({ limits: L, active_watches: undefined, active_watches_for_symbol: undefined }));
    assert.equal(r.ok, true);
  });
  it("R-SLOT: one slot below the cap passes", () => {
    assert.equal(validate(INTENT, okCtx({ active_watches: 4, active_watches_for_symbol: 1 })).ok, true);
  });

  // --- stop_loss (direction consistency, part of R-NOT) ---------------------
  it("stop_loss: a LONG stop above the entry is rejected", () => {
    const r = validate({ ...INTENT, stop_loss: "110" }, okCtx()); // entry 100
    assert.equal(r.code, "R-NOT");
    assert.equal(r.detail.stop_loss, "110");
  });
  it("stop_loss: a SHORT stop below the entry is rejected", () => {
    const ctx = okCtx({ watch: { id: "w1", symbol: "BTCUSDT", direction: "SHORT" } });
    assert.equal(validate({ ...INTENT, side: "SELL", stop_loss: "90" }, ctx).code, "R-NOT");
  });
  it("stop_loss: a direction-consistent stop passes", () => {
    assert.equal(validate({ ...INTENT, stop_loss: "90" }, okCtx()).ok, true);
    const ctx = okCtx({ watch: { id: "w1", symbol: "BTCUSDT", direction: "SHORT" } });
    assert.equal(validate({ ...INTENT, side: "SELL", stop_loss: "110" }, ctx).ok, true);
  });
  it("stop_loss: a non-decimal stop fails closed", () => {
    assert.equal(validate({ ...INTENT, stop_loss: "1e3" }, okCtx()).code, "R-NOT");
  });
  it("stop_loss: a stop equal to the entry is rejected (it is not a stop)", () => {
    assert.equal(validate({ ...INTENT, stop_loss: "100" }, okCtx()).code, "R-NOT");
  });

  // --- R-STALE --------------------------------------------------------------
  it("R-STALE: aged price → HOLD + age/threshold", () => {
    const r = validate(INTENT, okCtx({ price: { px: "100", at_ms: NOW - 8000 } }));
    assert.equal(r.code, "R-STALE");
    assert.equal(r.detail.action, "HOLD");
    assert.equal(r.detail.threshold_s, 5);
  });
  it("R-STALE: a price with no timestamp fails closed", () => {
    // px is computable here, so R-NOT/R-EXP pass and the freshness gate catches it
    assert.equal(validate(INTENT, okCtx({ price: { px: "100" } })).code, "R-STALE");
  });
  it("R-NOT precedes R-STALE for a missing price (documented gate order)", () => {
    // no price at all → notional cannot be computed → R-NOT (first failure wins)
    assert.equal(validate(INTENT, okCtx({ price: null })).code, "R-NOT");
  });

  // --- R-DUP ----------------------------------------------------------------
  it("R-DUP: live intent for the same approval → 409-class reject", () => {
    const r = validate(INTENT, okCtx({ live_intent_for_approval: true }));
    assert.equal(r.code, "R-DUP");
    assert.equal(r.detail.approval_id, "a1");
  });
  it("R-DUP: unknown dup state fails closed", () => {
    const ctx = okCtx(); delete ctx.live_intent_for_approval;
    assert.equal(validate(INTENT, ctx).code, "R-DUP");
  });
});
describe("E08-T01 coverage, order, and AI-override immunity", () => {
  it("100% reject coverage: every code has a red path (acceptance)", () => {
    const red = {
      "R-KILL": okCtx({ kill: { engaged: true } }),
      "R-APPROVAL": okCtx({ approval: null }),
      "R-SYM": okCtx({ watch: { id: "w", symbol: "DOGEUSDT", direction: "LONG" } }),
      "R-LEV": okCtx(),
      "R-NOT": okCtx(),
      "R-EXP": okCtx({ exposure: { open_notional_usd: "4500" } }), // 4500 + 1000 > 5000
      "R-STALE": okCtx({ price: { px: "100", at_ms: NOW - 8000 } }),
      "R-DUP": okCtx({ live_intent_for_approval: true }),
      "R-SLOT": okCtx({ active_watches: 5 }), // global cap reached (5 >= 5)
    };
    const seen = [];
    for (const code of RISK_CODES) {
      const intent = code === "R-LEV" ? { ...INTENT, leverage: 6 }
        : code === "R-NOT" ? { ...INTENT, qty: "11" }
        : code === "R-EXP" ? { ...INTENT, qty: "10" }
        : code === "R-SLOT" ? { ...INTENT } : INTENT;
      const r = validate(intent, red[code]);
      assert.equal(r.code, code, code);
      seen.push(r.code);
    }
    assert.deepEqual(seen.sort(), [...RISK_CODES].sort()); // all 9, no extras
  });

  it("fixed evaluation order: peel one gate at a time, code advances in table order", () => {
    const broken = okCtx({
      kill: { engaged: true },
      approval: null,
      watch: null,
      exposure: null, // unknown → R-EXP once notional is computable
      price: { px: "100" }, // present but no timestamp → R-STALE later
      live_intent_for_approval: true,
    });
    const badIntent = { ...INTENT, leverage: 99, qty: "999" };
    const grant = { decision: "approve", used_at: null, expires_at: new Date(NOW + 600_000).toISOString() };
    assert.equal(validate(badIntent, broken).code, "R-KILL");
    assert.equal(validate(badIntent, { ...broken, kill: { engaged: false } }).code, "R-APPROVAL");
    assert.equal(validate(badIntent, { ...broken, kill: { engaged: false }, approval: grant }).code, "R-SYM");
    const ctx3 = { ...broken, kill: { engaged: false }, approval: grant, watch: { id: "w", symbol: "BTCUSDT", direction: "LONG" } };
    assert.equal(validate(badIntent, ctx3).code, "R-LEV");
    assert.equal(validate({ ...badIntent, leverage: 5 }, ctx3).code, "R-NOT");
    assert.equal(validate({ ...badIntent, leverage: 5, qty: "1" }, ctx3).code, "R-EXP");
    const ctx5 = { ...ctx3, exposure: { open_notional_usd: "0" } };
    delete ctx5.active_watches; // unknown count must fail closed → R-SLOT before R-STALE
    assert.equal(validate({ ...badIntent, leverage: 5, qty: "1" }, ctx5).code, "R-SLOT"); // active_watches undefined → fail closed
    const ctx6 = { ...ctx5, active_watches: 0, active_watches_for_symbol: 0 }; // price still has no timestamp → R-STALE
    assert.equal(validate({ ...badIntent, leverage: 5, qty: "1" }, ctx6).code, "R-STALE");
    const ctx7 = { ...ctx6, price: { px: "100", at_ms: NOW - 1000 } };
    assert.equal(validate({ ...badIntent, leverage: 5, qty: "1" }, ctx7).code, "R-DUP");
    assert.equal(validate({ ...badIntent, leverage: 5, qty: "1" }, { ...ctx7, live_intent_for_approval: false }).ok, true);
  });

  it("AI output is an input, never an override (SAFE-003)", () => {
    const ai = { bias: "LONG", confidence: 0.99, reasons: ["strong setup"] };
    assert.deepEqual(validate({ ...INTENT, leverage: 99, ...ai }, okCtx()).detail, { limit: 5, asked: 99 });
    assert.equal(validate({ ...INTENT, qty: "50", ...ai }, okCtx()).code, "R-NOT");
    assert.equal(validate({ ...INTENT, leverage: 99 }, okCtx()).code, "R-LEV"); // gates never read AI fields
  });
});