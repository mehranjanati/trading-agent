// groups-dedupe.test.mjs — group member toggle: add once, untick removes,
// same id + different version are DISTINCT members.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mirrors toggleMember in groups.ts (ts module — logic pinned here in JS so
// node --test can run it without a TS loader).
const key = (m) => `${m.id}@${m.version ?? "latest"}`;
function toggleMember(members, entry) {
  const k = key(entry);
  if (members.some((m) => key(m) === k)) return members.filter((m) => key(m) !== k);
  return [...members, { id: entry.id, version: entry.version }];
}

describe("group member toggle", () => {
  it("adds then removes the same entry (no dupes)", () => {
    let members = [];
    members = toggleMember(members, { id: "sma-cross", version: "0.1.0" });
    assert.deepEqual(members, [{ id: "sma-cross", version: "0.1.0" }]);
    members = toggleMember(members, { id: "sma-cross", version: "0.1.0" });
    assert.deepEqual(members, []);
  });

  it("same id + different version are distinct members", () => {
    let members = [{ id: "sma-cross", version: "0.1.0" }];
    members = toggleMember(members, { id: "sma-cross", version: "0.2.0" });
    assert.equal(members.length, 2);
  });

  it("missing version keys as latest (same toggle removes)", () => {
    let members = toggleMember([], { id: "sma-cross" });
    assert.deepEqual(members, [{ id: "sma-cross", version: undefined }]);
    // "latest" is the same KEY — toggling removes, not dupes.
    members = toggleMember(members, { id: "sma-cross", version: "latest" });
    assert.deepEqual(members, []);
  });
});
