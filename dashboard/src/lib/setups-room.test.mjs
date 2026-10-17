// setups-room.test.mjs — the setup room keeps a watch (and everything linked to
// it) visible across the WHOLE watch lifecycle.
//
// Regression this file exists for: the room read `/api/watches?status=ACTIVE`
// and joined approvals/orders/analysis runs through those ACTIVE-only ids. A
// stalked zone that triggered (or was invalidated) therefore emptied the room —
// watch, approvals and orders disappeared together and the trade looked DELETED,
// although the FSM only ever transitions a watch (docs/05 §5.3) and D1 still held
// every row. Reported from a real stalk: CELRUSDT SHORT armed at 15:09 against a
// zone whose trigger sat ~0.06% from the anchor close, so the very next tick
// decided it and the room went blank.
//
// Imports the real module (setups-core.mjs), not a hand-copied mirror.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { roomWatches, roomWatchIds, deriveStatus, linkStrategy, unlinkStrategy, linkGroup, unlinkGroup, renameGroupLinks, dropGroupLinks, groupRooms, strategyRefKey } from "./setups-core.mjs";

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// The CELRUSDT room as the API returns it: one ACTIVE watch, one older watch
// that already did its job, and a third symbol that must never leak in.
const WATCHES = [
  { id: "w_old", symbol: "CELRUSDT", status: "INVALIDATED", direction: "SHORT", version: 3, updated_at: iso(NOW - 3_600_000) },
  { id: "w_btc", symbol: "BTCUSDT", status: "ACTIVE", direction: "LONG", version: 2, updated_at: iso(NOW - 60_000) },
  { id: "w_new", symbol: "CELRUSDT", status: "ACTIVE", direction: "SHORT", version: 2, updated_at: iso(NOW - 1_000) },
  { id: "w_done", symbol: "CELRUSDT", status: "ANALYZED", direction: "SHORT", version: 4, updated_at: iso(NOW - 500) },
];

describe("roomWatches — the symbol's watches, ACTIVE first, then newest", () => {
  it("keeps every status (a triggered/invalidated watch is not deleted)", () => {
    const rows = roomWatches(WATCHES, "CELRUSDT");
    assert.deepEqual(rows.map((w) => w.id), ["w_new", "w_done", "w_old"]);
  });

  it("never leaks another symbol's watches", () => {
    assert.deepEqual(roomWatches(WATCHES, "ETHUSDT"), []);
  });

  it("orders the non-ACTIVE tail by updated_at desc, then id", () => {
    const rows = roomWatches([
      { id: "b", symbol: "XUSDT", status: "CLOSED", updated_at: iso(NOW) },
      { id: "a", symbol: "XUSDT", status: "CLOSED", updated_at: iso(NOW) },
      { id: "c", symbol: "XUSDT", status: "TRIGGERED", updated_at: iso(NOW - 1) },
    ], "XUSDT");
    assert.deepEqual(rows.map((w) => w.id), ["a", "b", "c"]);
  });

  it("survives a missing/odd list and missing stamps (no throw, no invented row)", () => {
    assert.deepEqual(roomWatches(null, "CELRUSDT"), []);
    assert.deepEqual(roomWatches(undefined, "CELRUSDT"), []);
    const rows = roomWatches([{ id: "w1", symbol: "CELRUSDT", status: "ACTIVE" }], "CELRUSDT");
    assert.deepEqual(rows.map((w) => w.id), ["w1"]);
  });
});

describe("roomWatchIds — the join key spans the whole lifecycle", () => {
  it("includes a watch that already left ACTIVE", () => {
    assert.deepEqual(roomWatchIds(WATCHES, "CELRUSDT"), ["w_new", "w_done", "w_old"]);
  });

  it("is empty for a symbol with no watches", () => {
    assert.deepEqual(roomWatchIds(WATCHES, "DOGEUSDT"), []);
  });
});

const base = {
  positions: [],
  watches: WATCHES,
  watchIds: roomWatchIds(WATCHES, "CELRUSDT"),
};

describe("deriveStatus — a triggered watch still drives the room's status", () => {
  it("STALKING only while a watch is ACTIVE", () => {
    const s = deriveStatus("CELRUSDT", { ...base, approvals: [] });
    assert.equal(s, "STALKING");
  });

  it("AWAITING-APPROVAL after the watch left ACTIVE (the case an ACTIVE-only room lost)", () => {
    const approvals = [{ watch_id: "w_done", used_at: null, expires_at: iso(NOW + 600_000) }];
    assert.equal(deriveStatus("CELRUSDT", { ...base, approvals }), "AWAITING-APPROVAL");
  });

  it("an ACTIVE-only watch list reports IDLE for that same symbol (the old bug)", () => {
    const approvals = [{ watch_id: "w_done", used_at: null, expires_at: iso(NOW + 600_000) }];
    // The symbol's only watches already left ACTIVE — exactly the CELR case: the
    // zone triggered and the ACTIVE-only feed returned nothing for it.
    const leftActive = WATCHES.filter((w) => w.symbol === "CELRUSDT" && w.status !== "ACTIVE");
    assert.equal(deriveStatus("CELRUSDT", {
      positions: [], watches: leftActive, watchIds: roomWatchIds(leftActive, "CELRUSDT"), approvals,
    }), "AWAITING-APPROVAL");
    const activeOnly = leftActive.filter((w) => w.status === "ACTIVE");
    assert.equal(deriveStatus("CELRUSDT", {
      positions: [], watches: activeOnly, watchIds: roomWatchIds(activeOnly, "CELRUSDT"), approvals,
    }), "IDLE");
  });

  it("a consumed or expired approval is not pending, and OPEN wins over both", () => {
    const consumed = [{ watch_id: "w_done", used_at: iso(NOW - 1), expires_at: iso(NOW + 600_000) }];
    const expired = [{ watch_id: "w_done", used_at: null, expires_at: iso(NOW - 1) }];
    const noActive = { positions: [], watches: [], watchIds: ["w_done"] };
    assert.equal(deriveStatus("CELRUSDT", { ...noActive, approvals: consumed }), "IDLE");
    assert.equal(deriveStatus("CELRUSDT", { ...noActive, approvals: expired }), "IDLE");
    assert.equal(deriveStatus("CELRUSDT", {
      positions: [{ symbol: "CELRUSDT", size: "10" }], watches: [], watchIds: [], approvals: [],
    }), "OPEN");
  });
});

// The second half of the report: a room's own selection was append-only. The
// strategies page could link a group to a symbol and nothing could ever take it
// back, `SymbolSetup.strategies` was written by nobody (so "strategies in play"
// was permanently empty), and deleting a group left every room that linked it
// pointing at a name that no longer existed.
const ROOM = (patch = {}) => ({
  CELRUSDT: { symbol: "CELRUSDT", chatSession: null, strategies: [], groups: [], analyzes: [], watches: [], updatedAt: iso(NOW), ...patch },
});

describe("room links — strategies and groups can be added AND removed", () => {
  it("links a strategy once, and a different version is a different entry", () => {
    let rooms = linkStrategy(ROOM(), "celrusdt", { id: "sma-cross", version: "0.1.0" });
    rooms = linkStrategy(rooms, "CELRUSDT", { id: "sma-cross", version: "0.1.0" }); // idempotent
    rooms = linkStrategy(rooms, "CELRUSDT", { id: "sma-cross", version: "0.2.0" });
    assert.deepEqual(rooms.CELRUSDT.strategies, [
      { id: "sma-cross", version: "0.1.0" },
      { id: "sma-cross", version: "0.2.0" },
    ]);
    assert.equal(strategyRefKey({ id: "sma-cross" }), "sma-cross@latest");
  });

  it("unlinks exactly one id@version and leaves the rest", () => {
    let rooms = linkStrategy(ROOM(), "CELRUSDT", { id: "a", version: "1" });
    rooms = linkStrategy(rooms, "CELRUSDT", { id: "a", version: "2" });
    rooms = unlinkStrategy(rooms, "CELRUSDT", { id: "a", version: "1" });
    assert.deepEqual(rooms.CELRUSDT.strategies, [{ id: "a", version: "2" }]);
  });

  it("linking a strategy creates the room instead of throwing it away", () => {
    const rooms = linkStrategy({}, "ETHUSDT", { id: "sma-x-v2", version: "0.1.0" });
    assert.deepEqual(rooms.ETHUSDT.strategies, [{ id: "sma-x-v2", version: "0.1.0" }]);
    assert.equal(linkStrategy({}, "", { id: "x" })[""], undefined); // blank symbol is a no-op
  });

  it("links and unlinks a group", () => {
    let rooms = linkGroup(ROOM(), "CELRUSDT", "rsi-block");
    rooms = linkGroup(rooms, "CELRUSDT", "rsi-block"); // idempotent
    assert.deepEqual(rooms.CELRUSDT.groups, ["rsi-block"]);
    rooms = unlinkGroup(rooms, "CELRUSDT", "rsi-block");
    assert.deepEqual(rooms.CELRUSDT.groups, []);
  });

  it("a group rename follows into every room that linked it", () => {
    const rooms = {
      ...ROOM({ groups: ["rsi-block"] }),
      BTCUSDT: { symbol: "BTCUSDT", chatSession: null, strategies: [], groups: ["rsi-block", "other"], analyzes: [], watches: [], updatedAt: iso(NOW) },
      ETHUSDT: { symbol: "ETHUSDT", chatSession: null, strategies: [], groups: [], analyzes: [], watches: [], updatedAt: iso(NOW) },
    };
    const next = renameGroupLinks(rooms, "rsi-block", "rsi-div-block");
    assert.deepEqual(next.CELRUSDT.groups, ["rsi-div-block"]);
    assert.deepEqual(next.BTCUSDT.groups, ["rsi-div-block", "other"]);
    assert.deepEqual(next.ETHUSDT.groups, []);
  });

  it("deleting a group removes it from every room (no ghost reference)", () => {
    const rooms = {
      ...ROOM({ groups: ["rsi-block"] }),
      BTCUSDT: { symbol: "BTCUSDT", chatSession: null, strategies: [], groups: ["rsi-block", "keep"], analyzes: [], watches: [], updatedAt: iso(NOW) },
    };
    const next = dropGroupLinks(rooms, "rsi-block");
    assert.deepEqual(next.CELRUSDT.groups, []);
    assert.deepEqual(next.BTCUSDT.groups, ["keep"]);
    assert.deepEqual(groupRooms(rooms, "rsi-block"), ["BTCUSDT", "CELRUSDT"]);
    assert.deepEqual(groupRooms(next, "rsi-block"), []);
  });
});
