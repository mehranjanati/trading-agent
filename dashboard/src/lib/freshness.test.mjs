// freshness.test.mjs — E10-T01-S2/S3: badge coverage + degraded-UX acceptance.
// These run in `make check` (Node stdlib) — the Svelte components are thin
// wrappers over this pure module, so UI behaviour is pinned without a browser.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { badge, modeBanner, actionBlocker, countdown, timeline, LIVE_MAX_MS, BADGES } from "./freshness.mjs";

const NOW = 1_800_000_000_000;

describe("E10-T01-S2 freshness badges (docs/09 §9.2)", () => {
  it("LIVE under 5s, STALE at/after the threshold", () => {
    assert.equal(badge({ ageMs: LIVE_MAX_MS - 1 }).label, "LIVE");
    assert.equal(badge({ ageMs: LIVE_MAX_MS }).label, "STALE");
    assert.equal(badge({ ageMs: 12_000 }).label, "STALE");
    assert.equal(badge({ ageMs: 4_000 }).tone, "green");
    assert.equal(badge({ ageMs: 6_000 }).tone, "amber");
  });
  it("CACHED (grey) for last-known, UNAVAILABLE (red) when the source is down", () => {
    assert.equal(badge({ ageMs: 1_000, source: "cached" }).label, "CACHED");
    assert.equal(badge({ ageMs: 1_000, source: "cached" }).tone, "grey");
    assert.equal(badge({ source: "unavailable" }).label, "UNAVAILABLE");
    assert.equal(badge({ source: "unavailable" }).tone, "red");
  });
  it("an unknown age is NEVER live (fail closed at the UI layer)", () => {
    for (const ageMs of [null, undefined, NaN, -1]) {
      assert.equal(badge({ ageMs }).label, "UNAVAILABLE", String(ageMs));
    }
  });
  it("badge coverage: all four labels reachable", () => {
    const labels = ["LIVE", "STALE", "CACHED", "UNAVAILABLE"].map((l) =>
      l === "LIVE" ? badge({ ageMs: 10 }).label
      : l === "STALE" ? badge({ ageMs: 9_000 }).label
      : l === "CACHED" ? badge({ ageMs: 10, source: "cached" }).label
      : badge({ source: "unavailable" }).label);
    assert.deepEqual(labels.sort(), [...Object.values(BADGES)].sort());
  });
});

describe("E10-T01-S2 mode banner + degraded UX (docs/09 §9.4)", () => {
  it("hidden on PRIMARY, visible with cause + limitations otherwise", () => {
    assert.equal(modeBanner("PRIMARY").visible, false);
    for (const mode of ["DEGRADED", "FALLBACK", "HALTED", "D1_DOWN"]) {
      const b = modeBanner(mode, ["go_unhealthy"]);
      assert.equal(b.visible, true, mode);
      assert.ok(b.text.includes(mode), mode);
      assert.ok(b.limitations.length > 0, mode);
    }
  });
  it("ACCEPTANCE: fallback → banner + STALE/CACHED badges, orders blocked by default", () => {
    const b = modeBanner("FALLBACK");
    assert.ok(b.text.includes("REST poller"));
    assert.ok(b.limitations.some((l) => l.includes("blocked")));
    const stale = badge({ ageMs: 9_000 });
    const cached = badge({ ageMs: 1_000, source: "cached" });
    assert.equal(stale.label, "STALE");
    assert.equal(cached.label, "CACHED");
  });
  it("ACCEPTANCE: an uncertain approval is disabled with a verbatim reason", () => {
    assert.deepEqual(actionBlocker({ priceAgeMs: 12_000 }), { blocked: true, reason: "blocked: STALE price (12s)" });
    assert.deepEqual(actionBlocker({ priceAgeMs: null }), { blocked: true, reason: "blocked: UNAVAILABLE price" });
    assert.deepEqual(actionBlocker({ mode: "HALTED" }).reason, "blocked: HALTED — kill switch engaged");
    assert.deepEqual(actionBlocker({ killEngaged: true }).reason, "blocked: kill switch engaged");
    assert.deepEqual(actionBlocker({ mode: "FALLBACK", priceAgeMs: 1_000 }).reason, "blocked: FALLBACK");
    assert.equal(actionBlocker({ priceAgeMs: 1_000 }), null); // fresh + primary → allowed
  });
});

describe("E10-T01-S3 countdown + timelines", () => {
  it("approval countdown is live and expires at zero", () => {
    const c = countdown(new Date(NOW + 65_000).toISOString(), NOW);
    assert.equal(c.text, "1:05");
    assert.equal(c.seconds_left, 65);
    assert.equal(c.expired, false);
    const e = countdown(new Date(NOW - 1).toISOString(), NOW);
    assert.equal(e.expired, true);
    assert.equal(e.text, "expired");
    assert.equal(countdown("soon", NOW).valid, false);
  });
  it("timelines show explicit gaps and never interpolate", () => {
    const rows = timeline([
      { at: new Date(NOW).toISOString(), kind: "evt", type: "a" },
      { at: new Date(NOW + 60_000).toISOString(), kind: "evt", type: "b" },
    ], { nowMs: NOW + 120_000 });
    const gaps = rows.filter((r) => r.kind === "gap");
    assert.equal(gaps.length, 2); // one between, one open to now
    assert.equal(gaps[0].seconds, 60);
    assert.equal(gaps[1].open, true);
  });
});