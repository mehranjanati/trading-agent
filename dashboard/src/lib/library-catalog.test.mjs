// library-catalog.test.mjs — the strategy catalog is READ FROM the Go registry
// endpoint, never hardcoded.
//
// Regression this file exists for: the library tab listed the pinned strategies
// from a constant in library.ts, so it could (and did) drift from
// go-watcher/strategies/samples/registry.json — the file the runner actually
// executes. The rule now: the endpoint is the source, the checked-in mirror is
// only the labelled offline fallback.
//
// Imports the real module (library-core.mjs), not a hand-copied mirror.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeCatalog, pinnedEntry, draftEntry, entryKey, PINNED_FALLBACK } from "./library-core.mjs";

const LIVE = [
  { id: "sma-cross", version: "0.1.0", name: "SMA Cross (fast)", description: "fast 2 / slow 3", sha256: "aa".repeat(32), configuration: { fast_window: 2 } },
  { id: "rsi-div", version: "1.0.0", name: "RSI Divergence", description: "new pin", sha256: "bb".repeat(32), configuration: {} },
];

describe("catalog — the Go registry endpoint is the source", () => {
  it("live rows win and carry the artifact hash the runner will execute", () => {
    const { entries, source } = composeCatalog(LIVE, []);
    assert.equal(source, "registry");
    assert.deepEqual(entries.map((e) => e.label), ["sma-cross@0.1.0", "rsi-div@1.0.0"]);
    assert.equal(entries[0].sha256, "aa".repeat(32));
    assert.equal(entries[0].kind, "pinned");
    assert.deepEqual(entries[0].configuration, { fast_window: 2 });
    // A pin the constant has never heard of must still show up.
    assert.ok(entries.some((e) => e.label === "rsi-div@1.0.0"));
  });

  it("an unreachable registry falls back to the checked-in mirror and SAYS so", () => {
    for (const empty of [null, undefined, []]) {
      const { entries, source } = composeCatalog(empty, []);
      assert.equal(source, "fallback", `${empty} must not read as a live registry`);
      assert.equal(entries.length, PINNED_FALLBACK.length);
      assert.deepEqual(entries.map((e) => e.label), PINNED_FALLBACK.map((p) => `${p.id}@${p.version}`));
      // The mirror has no hashes — the UI must not imply an artifact it never read.
      assert.ok(entries.every((e) => e.sha256 === undefined));
    }
  });

  it("drafts ride along, and a built draft graduates to pinned without dupes", () => {
    const drafts = [
      { id: "dr_1", strategy_id: "sma-cross", version: "0.1.0", status: "generated" }, // already pinned
      { id: "dr_2", strategy_id: "macd-x", version: "0.3.0", status: "generated" },
    ];
    const { entries, source } = composeCatalog(LIVE, drafts);
    assert.equal(source, "registry");
    assert.deepEqual(entries.map((e) => e.label), ["sma-cross@0.1.0", "rsi-div@1.0.0", "macd-x@0.3.0"]);
    assert.equal(entries.at(-1).kind, "draft");
    assert.equal(entries.at(-1).draftId, "dr_2");
  });

  it("drafts survive an unreachable registry too", () => {
    const { entries, source } = composeCatalog(null, [{ id: "dr_9", strategy_id: "only-draft", version: "0.1.0", status: "rejected" }]);
    assert.equal(source, "fallback");
    assert.equal(entries.length, PINNED_FALLBACK.length + 1);
    assert.equal(entries.at(-1).label, "only-draft@0.1.0");
    assert.equal(entries.at(-1).blurb, "draft rejected");
  });
});

describe("catalog — entry shaping", () => {
  it("pinnedEntry joins name + description into the blurb", () => {
    assert.equal(pinnedEntry({ id: "a", version: "1.0.0", name: "A", description: "does a" }).blurb, "A — does a");
    assert.equal(pinnedEntry({ id: "a", version: "1.0.0", name: "A" }).blurb, "A");
    assert.equal(pinnedEntry({ id: "a", version: "1.0.0" }).blurb, "pinned wasm");
  });

  it("entryKey treats a missing version as latest", () => {
    assert.equal(entryKey("sma-cross", "0.1.0"), "sma-cross@0.1.0");
    assert.equal(entryKey("sma-cross"), "sma-cross@latest");
    assert.equal(draftEntry({ id: "d", strategy_id: "s", version: "2.0.0", status: "generated" }).label, "s@2.0.0");
  });
});
