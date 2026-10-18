// groups-edit.test.mjs — editing and deleting a SAVED group.
//
// Regression this file exists for: once saved, a group was frozen — the card
// listed its members and offered a bare `delete group`. There was no rename, no
// job change, no way to add or remove a member; a rename would also have left
// every room that linked the group pointing at a name that no longer existed
// (the group name IS the join key between the two localStorage stores), and the
// editor's tick-list had to keep members the current library no longer carries
// (a deleted draft, an unpinned version) instead of dropping them silently.
//
// Imports the real module (groups-core.mjs), not a hand-copied mirror.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupEditRows, groupEditError, groupEditNote, groupDeleteNote, groupMemberKey } from "./groups-core.mjs";

const CATALOG = [
  { id: "sma-cross", version: "0.1.0", kind: "pinned", label: "sma-cross@0.1.0", blurb: "fast 2 / slow 3" },
  { id: "sma-x-v2", version: "0.1.0", kind: "pinned", label: "sma-x-v2@0.1.0", blurb: "fast 5 / slow 20" },
];

describe("groupEditRows — the tick-list an edit opens with", () => {
  it("carries every library entry and pre-ticks the stored members", () => {
    const rows = groupEditRows(CATALOG, [{ id: "sma-cross", version: "0.1.0" }]);
    assert.deepEqual(rows.map((r) => r.label), ["sma-cross@0.1.0", "sma-x-v2@0.1.0"]);
  });

  it("keeps a member the library no longer carries, labelled, instead of dropping it", () => {
    const rows = groupEditRows(CATALOG, [
      { id: "sma-cross", version: "0.1.0" },
      { id: "old-draft", version: "0.9.0" },
      { id: "sma-x-v2" },
    ]);
    const extra = rows.find((r) => r.kind === "missing");
    assert.equal(extra.label, "old-draft@0.9.0");
    assert.match(extra.blurb, /not in the current library/);
    assert.equal(rows.length, 4); // 2 catalog + 2 stored-but-missing (sma-x-v2@latest too)
  });

  it("never duplicates a member that is both stored and in the library", () => {
    const rows = groupEditRows(CATALOG, CATALOG.map((e) => ({ id: e.id, version: e.version })));
    assert.equal(rows.length, 2);
  });

  it("handles a missing catalog or member list", () => {
    assert.deepEqual(groupEditRows(null, null), []);
    assert.deepEqual(groupEditRows(undefined, [{ id: "x" }]).map((r) => r.label), ["x@latest"]);
  });

  it("groupMemberKey treats the same id at another version as another member", () => {
    assert.equal(groupMemberKey({ id: "a", version: "1" }), "a@1");
    assert.notEqual(groupMemberKey({ id: "a", version: "1" }), groupMemberKey({ id: "a", version: "2" }));
    assert.equal(groupMemberKey({ id: "a" }), "a@latest");
  });
});

describe("groupEditError — what blocks an edit", () => {
  it("needs a name", () => {
    assert.equal(groupEditError("", 2, "old", []), "لطفاً نام گروهی وارد کنید");
    assert.equal(groupEditError("   ", 2, "old", []), "لطفاً نام گروهی وارد کنید");
  });

  it("needs at least one member", () => {
    assert.equal(groupEditError("g", 0, "old", []), "حداقل یک استراتژی را تیک بزنید");
  });

  it("refuses to rename onto a sibling (never a silent overwrite)", () => {
    assert.match(groupEditError("taken", 1, "old", ["taken"]), /از قبل وجود دارد/);
    assert.equal(groupEditError("old", 1, "old", ["old", "taken"]), null); // its own name is fine
  });

  it("a valid edit passes", () => {
    assert.equal(groupEditError("new-name", 3, "old", ["taken"]), null);
  });
});

describe("groupEditNote / groupDeleteNote — the action always answers", () => {
  it("names the new state and says the rename reached the rooms", () => {
    assert.match(groupEditNote("g2", 2, "g1"), /نام قبلی «g1»/);
    assert.doesNotMatch(groupEditNote("g1", 2, "g1"), /نام قبلی/);
  });

  it("a delete reports the rooms it unlinked", () => {
    assert.match(groupDeleteNote("g1", ["CELRUSDT", "BTCUSDT"]), /2 اتاق \(CELRUSDT, BTCUSDT\)/);
    assert.doesNotMatch(groupDeleteNote("g1", []), /اتاق/);
  });
});

describe("groupEditRows — a RETIRED version (ADR-011)", () => {
  const CAT = [
    { id: "sma-cross", version: "0.1.0", kind: "pinned", label: "sma-cross@0.1.0", blurb: "", status: "active" },
    { id: "sma-cross", version: "0.9.0", kind: "pinned", label: "sma-cross@0.9.0", blurb: "", status: "retired" },
  ];

  it("stays visible but is not selectable for a NEW group", () => {
    const rows = groupEditRows(CAT, []);
    const retired = rows.find((r) => r.label === "sma-cross@0.9.0");
    assert.equal(retired.status, "retired");
    assert.equal(retired.selectable, false);
    assert.equal(rows.find((r) => r.label === "sma-cross@0.1.0").selectable, true);
  });

  it("an existing retired member is still listed once (kept, labelled)", () => {
    const rows = groupEditRows(CAT, [{ id: "sma-cross", version: "0.9.0" }]);
    assert.equal(rows.filter((r) => r.label === "sma-cross@0.9.0").length, 1);
    assert.equal(rows.length, 2);
  });

  it("a missing member is selectable only so it can be unticked/kept", () => {
    const rows = groupEditRows([], [{ id: "gone", version: "1.0.0" }]);
    assert.equal(rows[0].selectable, true);
    assert.equal(rows[0].kind, "missing");
  });
});
