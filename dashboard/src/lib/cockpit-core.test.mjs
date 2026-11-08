// cockpit-core.test.mjs — the cockpit's rules are pure, so they are testable
// without a browser (the freshness.test.mjs / setups-room.test.mjs pattern).
// The redirect table is asserted row-by-row against docs/20 §20.5: if the doc
// and the code ever disagree, this file fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  legacyRedirect,
  priceOf,
  priceBadge,
  partialPriceNote,
  parseZone,
  zoneText,
  watchBoard,
  approvalState,
  approvalLines,
  intentLines,
  symbolBoard,
  filterSymbols,
  aggregateSummary,
  incidentRows,
  signalRows,
  ACTIVITY_TABS,
  COCKPIT_PATH,
  EXECUTION_PATH,
  ACTIVITY_PATH,
} from "./cockpit-core.mjs";

test("legacyRedirect: every docs/20 §20.5 row maps", () => {
  assert.equal(legacyRedirect("/"), COCKPIT_PATH);
  assert.equal(legacyRedirect("/setups"), COCKPIT_PATH);
  assert.equal(legacyRedirect("/setups/btcusdt"), "/cockpit?symbol=BTCUSDT");
  assert.equal(legacyRedirect("/watches"), "/cockpit?tab=watches");
  assert.equal(legacyRedirect("/zones"), "/cockpit?tab=watches");
  assert.equal(legacyRedirect("/analyze"), "/cockpit?tab=analysis");
  assert.equal(legacyRedirect("/analysis"), "/cockpit?tab=analysis");
  assert.equal(legacyRedirect("/approvals"), EXECUTION_PATH);
  assert.equal(legacyRedirect("/orders"), EXECUTION_PATH);
  assert.equal(legacyRedirect("/signals"), `${ACTIVITY_PATH}?tab=signals`);
  assert.equal(legacyRedirect("/events"), `${ACTIVITY_PATH}?tab=events`);
  assert.equal(legacyRedirect("/logs"), `${ACTIVITY_PATH}?tab=errors`);
  assert.equal(legacyRedirect("/failover"), `${ACTIVITY_PATH}?tab=failover`);
  assert.equal(legacyRedirect("/strategies"), "/settings?tab=groups");
  assert.equal(legacyRedirect("/strategy"), "/settings?tab=limits");
  assert.equal(legacyRedirect("/alerts"), "/settings?tab=alerts");
});

test("legacyRedirect: un-consolidated routes return null (slice-by-slice safety)", () => {
  // /chat keeps the full editor (Q-18) and the four target views are their own
  // destinations — the map must not bounce them into each other.
  for (const p of ["/chat", "/cockpit", "/execution", "/activity", "/settings", "/nope"]) {
    assert.equal(legacyRedirect(p), null, p);
  }
});

test("legacyRedirect: the whole §20.5 table is covered — 17 legacy URLs, no gaps", () => {
  const legacy = [
    "/", "/setups", "/setups/BTCUSDT", "/watches", "/zones", "/analyze", "/analysis",
    "/approvals", "/orders", "/signals", "/events", "/logs", "/failover",
    "/strategies", "/strategy", "/alerts",
  ];
  for (const p of legacy) assert.ok(legacyRedirect(p), `${p} must redirect`);
});

test("legacyRedirect: carries the incoming search params and normalises the path", () => {
  assert.equal(legacyRedirect("/setups/BTCUSDT?x=1"), "/cockpit?symbol=BTCUSDT&x=1");
  assert.equal(legacyRedirect("/watches?symbol=ETHUSDT"), "/cockpit?symbol=ETHUSDT&tab=watches");
  assert.equal(legacyRedirect("/setups/"), "/cockpit");
  assert.equal(legacyRedirect(""), COCKPIT_PATH);
});

test("priceOf: an unanswered symbol is null, never an invented price", () => {
  assert.equal(priceOf({ BTCUSDT: "67000.5" }, "BTCUSDT"), "67000.5");
  assert.equal(priceOf({ BTCUSDT: "67000.5" }, "ETHUSDT"), null);
  assert.equal(priceOf({ BTCUSDT: "" }, "BTCUSDT"), null);
  assert.equal(priceOf(null, "BTCUSDT"), null);
});

// The 2026-11-08 symptom: the venue 403s Cloudflare's egress, so /api/prices
// answered 200 with `prices: {}` — a FRESH response carrying no number. The old
// badge followed the response's freshness and the desk showed a dash with no
// complaint. A price widget must fail closed (docs/09 §9.4).
test("priceBadge: no number is UNAVAILABLE, a D1 last-known row is CACHED", () => {
  const fresh = { ok: true, ageMs: 800, data: { prices: { BTCUSDT: "75894.1" }, missing: [] } };
  assert.equal(priceBadge(fresh, "BTCUSDT").label, "LIVE");
  assert.equal(priceBadge(fresh, "BTCUSDT").age_s, 1);

  // 200 OK, zero prices: nothing to render, so nothing may look live.
  const empty = { ok: true, ageMs: 200, data: { prices: {}, missing: ["BTCUSDT"] } };
  assert.equal(priceBadge(empty, "BTCUSDT").label, "UNAVAILABLE");
  assert.equal(priceBadge(empty, "BTCUSDT").tone, "red");

  // A failed read is never fresh either.
  assert.equal(priceBadge({ ok: false, error: "HTTP 500" }, "BTCUSDT").label, "UNAVAILABLE");
  assert.equal(priceBadge(null, "BTCUSDT").label, "UNAVAILABLE");

  // The D1 last-known price is honest — as long as it is labelled CACHED with age.
  const cached = { ok: true, ageMs: 3_600_000, data: { prices: { BTCUSDT: "80000" }, stale_symbols: ["BTCUSDT"], stale: true } };
  assert.equal(priceBadge(cached, "BTCUSDT").label, "CACHED");
  assert.equal(priceBadge(cached, "BTCUSDT").tone, "grey");
  assert.equal(priceBadge(cached, "BTCUSDT").age_s, 3600);

  // Go-plane gap fill is the SAME venue read a second ago: live, not cached.
  const bridged = { ok: true, ageMs: 900, data: { prices: { BTCUSDT: "75894.1" }, source: "go-watcher", bridged_symbols: ["BTCUSDT"] } };
  assert.equal(priceBadge(bridged, "BTCUSDT").label, "LIVE");
});

// The desk flapped between a price and an opaque "venue did not answer this
// symbol" — while the venue NEVER answers the Worker and the go-watcher bridge
// answered 24/25. The note must say what actually happened in that tick.
test("partialPriceNote: names the partial bridge answer, or the total failure", () => {
  // A price exists: nothing to explain.
  assert.equal(partialPriceNote({ prices: { DOGEUSDT: "0.21" } }, "DOGEUSDT", 25), null);

  // Partial bridge tick: the honest line, with the retry promise.
  const partial = {
    prices: { AAOIUSDT: "1", AAPLUSDT: "2" },
    missing: ["DOGEUSDT"],
    source: "go-watcher",
    bridged_symbols: ["AAOIUSDT", "AAPLUSDT"],
    degraded: "venue HTTP 403",
  };
  const note = partialPriceNote(partial, "DOGEUSDT", 25);
  assert.match(note, /venue HTTP 403/);
  assert.match(note, /bridge answered 2\/25 this tick — DOGEUSDT was not among them/);
  assert.match(note, /next tick/);

  // D1 covered the rest of the same tick.
  const withD1 = { ...partial, stale_symbols: ["ETHUSDT"] };
  assert.match(partialPriceNote(withD1, "DOGEUSDT", 25), /D1 last-known price covered the rest/);

  // Nothing answered at all: the worker's degraded reason stands alone.
  assert.match(
    partialPriceNote({ prices: {}, missing: ["DOGEUSDT"], degraded: "venue HTTP 403" }, "DOGEUSDT", 25),
    /^venue HTTP 403/,
  );

  // No degraded, no bridge: the old honest fallback stays.
  assert.match(partialPriceNote({ prices: {}, missing: ["DOGEUSDT"] }, "DOGEUSDT", 25), /venue did not answer/);

  // No data yet: loading, not an error.
  assert.equal(partialPriceNote(null, "DOGEUSDT", 25), "loading");
});

test("parseZone / zoneText: malformed JSON renders — instead of throwing", () => {
  assert.deepEqual(parseZone('{"op":">=","price":"67500"}'), { op: ">=", price: "67500" });
  assert.equal(parseZone("not-json"), null);
  assert.equal(parseZone("null"), null);
  assert.equal(parseZone(undefined), null);
  assert.equal(parseZone(""), null);
  assert.equal(parseZone("{}"), null); // an empty object is not a zone
  assert.equal(parseZone("[]"), null);
  assert.equal(zoneText('{"op":">=","price":"67500"}'), ">= 67500");
  assert.equal(zoneText("not-json"), "—");
  assert.equal(zoneText("{}"), "—");
  assert.equal(parseZone('{"price":1}').op, "?");
});

test("watchBoard: ACTIVE first, whole lifecycle kept, regime + zones rendered", () => {
  const watches = [
    { id: "w2", symbol: "BTCUSDT", status: "TRIGGERED", direction: "SHORT", version: 3, updated_at: "2026-10-01T10:00:00.000Z", trigger_json: '{"op":"<=","price":"66000"}', invalidation_json: '{"op":">=","price":"67000"}' },
    { id: "w1", symbol: "BTCUSDT", status: "ACTIVE", direction: "LONG", version: 2, updated_at: "2026-10-01T09:00:00.000Z", regime_filter: 1, trigger_json: '{"op":">=","price":"67500"}', invalidation_json: '{"op":"<=","price":"66800"}' },
    { id: "w9", symbol: "ETHUSDT", status: "ACTIVE", direction: "LONG" },
  ];
  const rows = watchBoard(watches, "BTCUSDT");
  assert.deepEqual(rows.map((r) => r.id), ["w1", "w2"]);
  assert.equal(rows[0].regime, "on");
  assert.equal(rows[0].trigger, ">= 67500");
  assert.equal(rows[1].trigger, "<= 66000");
  assert.equal(rows[1].invalidation, ">= 67000");
  assert.equal(rows[0].version, 2);
});

test("approvalState: mirrors the Worker and fails closed", () => {
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  assert.equal(approvalState(null, now), null);
  assert.equal(approvalState({ decision: "approve", expires_at: "2026-10-01T12:10:00.000Z" }, now), "granted");
  assert.equal(approvalState({ decision: "approve", expires_at: "2026-10-01T11:00:00.000Z" }, now), "expired");
  assert.equal(approvalState({ decision: "approve", expires_at: "not-a-date" }, now), "expired");
  assert.equal(approvalState({ decision: "reject", expires_at: "2026-10-01T12:10:00.000Z" }, now), "rejected");
  assert.equal(
    approvalState({ decision: "approve", used_at: "2026-10-01T11:59:00.000Z", expires_at: "2026-10-01T12:10:00.000Z" }, now),
    "consumed",
  );
});

test("approvalLines / intentLines: joined on the symbol's watch ids only", () => {
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  const approvals = [
    { id: "a1", watch_id: "w1", decision: "approve", expires_at: "2026-10-01T12:05:00.000Z", approver: "mehran" },
    { id: "a2", watch_id: "wX", decision: "approve", expires_at: "2026-10-01T12:05:00.000Z" },
  ];
  const lines = approvalLines(approvals, ["w1"], now);
  assert.deepEqual(lines.map((l) => l.id), ["a1"]);
  assert.equal(lines[0].state, "granted");
  assert.equal(lines[0].countdown, "5:00");

  const intents = [
    { id: "i1", watch_id: "w1", status: "SUBMIT_UNKNOWN", side: "BUY", qty: "0.01", leverage: 3, client_order_id: "i1" },
    { id: "i2", watch_id: "wX", status: "FILLED", side: "BUY", qty: "1", leverage: 1, client_order_id: "i2" },
  ];
  const irows = intentLines(intents, ["w1"]);
  assert.deepEqual(irows.map((r) => r.id), ["i1"]);
  assert.match(String(irows[0].status), /SUBMIT_UNKNOWN/);
});

test("symbolBoard: status comes from the shared derivation, tradeable from the allowlist", () => {
  const future = new Date(Date.now() + 600_000).toISOString();
  const board = symbolBoard({
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
    allowlist: ["BTCUSDT", "ETHUSDT"],
    prices: { BTCUSDT: "67000" },
    positions: [{ symbol: "BTCUSDT", size: "0.5" }],
    watches: [
      { id: "w1", symbol: "BTCUSDT", status: "ACTIVE" },
      { id: "w2", symbol: "ETHUSDT", status: "TRIGGERED" },
      { id: "w3", symbol: "SOLUSDT", status: "ACTIVE" },
    ],
    approvals: [{ id: "a1", watch_id: "w2", used_at: null, expires_at: future }],
  });
  const by = Object.fromEntries(board.map((r) => [r.symbol, r]));
  assert.equal(by.BTCUSDT.status, "OPEN"); // an open position outranks a pending token
  assert.equal(by.BTCUSDT.price, "67000");
  assert.equal(by.ETHUSDT.status, "AWAITING-APPROVAL");
  assert.equal(by.SOLUSDT.status, "STALKING");
  assert.equal(by.XRPUSDT.status, "IDLE");
  assert.equal(by.XRPUSDT.price, null);
  assert.equal(by.BTCUSDT.tradeable, true);
  assert.equal(by.XRPUSDT.tradeable, false);
  assert.equal(by.SOLUSDT.active, 1);
});

test("filterSymbols: pins live rooms first, then filters", () => {
  const rows = [
    { symbol: "AAAUSDT", status: "IDLE" },
    { symbol: "BBBUSDT", status: "STALKING" },
    { symbol: "CCCUSDT", status: "IDLE" },
    { symbol: "DDDUSDT", status: "OPEN" },
  ];
  assert.deepEqual(filterSymbols(rows).map((r) => r.symbol), ["BBBUSDT", "DDDUSDT", "AAAUSDT", "CCCUSDT"]);
  assert.deepEqual(filterSymbols(rows, "cc").map((r) => r.symbol), ["CCCUSDT"]);
  assert.deepEqual(filterSymbols(rows, "dd").map((r) => r.symbol), ["DDDUSDT"]);
  assert.deepEqual(filterSymbols(null), []);
  assert.equal(filterSymbols(rows, "", 2).length, 2);
});

test("aggregateSummary: a vote share, never a probability", () => {
  const s = aggregateSummary({
    aggregate: { bias: "LONG", confidence: 0.72, agree: 2, disagree: 1, flat: 0, errors: 0, n: 3, explanation: "2 of 3 agree" },
  });
  assert.equal(s.bias, "LONG");
  assert.equal(s.agree, 2);
  assert.equal(s.n, 3);
  assert.equal(aggregateSummary({}), null);
  assert.equal(aggregateSummary(null), null);
});

test("incidentRows: errors / failover filters, unknown tab falls back to events", () => {
  const incidents = [
    { incident: "order.submit_unknown", action: "client=x" },
    { incident: "lease.fenced", action: "epoch=3" },
    { incident: "reconcile.complete", action: "resolved=1" },
    { incident: "watch.triggered", action: "px=67000" },
  ];
  // ERROR_RE is the /logs filter: "unknown" AND "fenced" both match, exactly as
  // that page behaved before the merge (2 rows, not 1).
  const errors = incidentRows(incidents, "errors");
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((r) => r.incident), ["order.submit_unknown", "lease.fenced"]);
  // FAILOVER_RE is the old /failover filter: lease/takeover edges and the
  // reconcile certification — not every incident on the log.
  assert.deepEqual(incidentRows(incidents, "failover").map((r) => r.incident), ["lease.fenced", "reconcile.complete"]);
  assert.equal(incidentRows(incidents, "events").length, 4);
  assert.equal(incidentRows(incidents, "bogus").length, 4);
  assert.equal(incidentRows(null, "errors").length, 0);
});

test("signalRows: a signal without a watch renders a dash", () => {
  const rows = signalRows([{ id: "s1", kind: "MTF", source: "webhook", at: "t" }]);
  assert.equal(rows[0].watch_id, "—");
  assert.deepEqual(ACTIVITY_TABS, ["signals", "events", "errors", "failover"]);
});
