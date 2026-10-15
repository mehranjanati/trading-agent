// groups-save.test.mjs — the `save group` click path.
//
// Regression this file exists for: the button was `disabled` while the form was
// incomplete, so clicking it did nothing at all (no alert, no message) and the
// handler's validation was unreachable dead code. The rule is now: the click
// ALWAYS runs the validation and ALWAYS answers.
//
// Imports the real module (groups-core.mjs), not a hand-copied mirror — the same
// discipline as freshness.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupValidationError, groupMembers, groupStatusText } from "./groups-core.mjs";

describe("save group — validation always answers", () => {
  it("empty name reports the name, not the members", () => {
    assert.equal(groupValidationError("", []), "لطفاً نام گروهی وارد کنید");
    assert.equal(groupValidationError("", [{ id: "a", version: "0.1.0" }]), "لطفاً نام گروهی وارد کنید");
  });

  it("whitespace-only name is empty (the old `!gname.trim()` check)", () => {
    assert.equal(groupValidationError("   ", [{ id: "a", version: "0.1.0" }]), "لطفاً نام گروهی وارد کنید");
    assert.equal(groupValidationError(undefined, [{ id: "a" }]), "لطفاً نام گروهی وارد کنید");
  });

  it("no members reports the members once a name exists", () => {
    assert.equal(groupValidationError("rsi-div-block", []), "حداقل یک استراتژی را تیک بزنید");
    assert.equal(groupValidationError("rsi-div-block", undefined), "حداقل یک استراتژی را تیک بزنید");
  });

  it("a name + one member is savable", () => {
    assert.equal(groupValidationError("rsi-div-block", [{ id: "sma-cross", version: "0.1.0" }]), null);
  });
});

describe("save group — members & status line", () => {
  it("maps picked library entries to the stored member shape", () => {
    const entries = [
      { id: "sma-cross", version: "0.1.0", kind: "pinned", label: "sma-cross@0.1.0", blurb: "" },
      { id: "sma-x-v2", version: "0.1.0", kind: "pinned", label: "sma-x-v2@0.1.0", blurb: "" },
    ];
    assert.deepEqual(groupMembers(entries), [
      { id: "sma-cross", version: "0.1.0" },
      { id: "sma-x-v2", version: "0.1.0" },
    ]);
    assert.deepEqual(groupMembers(undefined), []);
  });

  it("the status line names what the form still needs", () => {
    assert.equal(groupStatusText("", "", 0), "enter a group name");
    assert.equal(groupStatusText("", "rsi-div-block", 0), "tick at least one strategy");
    assert.equal(groupStatusText("", "rsi-div-block", 1), "ready to save — 1 strategy");
    assert.equal(groupStatusText("", "rsi-div-block", 3), "ready to save — 3 strategies");
  });

  it("the last action result wins over the live hint", () => {
    assert.equal(groupStatusText("گروه «g» ذخیره شد (2 استراتژی)", "", 0), "گروه «g» ذخیره شد (2 استراتژی)");
  });
});
