// chaos.test.mjs — E06-T02-S1: harness safety rails, RESP codec and drill
// assertions (node:test, stdlib). No process is signalled and no socket is opened:
// the runner takes injectable IO, so a dry run can be proven side-effect free.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs, guard, planFor, respCommand, parseReply, hostOf, splitHostPort,
  assertRowsComplete, assertZeroDupIntents, assertWatchSetEqual, assertRejoinOrder,
  assertModeTimeline, assertNoBackoffAlert, assertBudget, budgetFloorSec,
  evidenceName, renderEvidence, run, DRILLS, COMPONENTS,
} from "./chaos.mjs";

/** IO stub that records every call — a dry run must leave it untouched. */
function stubIo() {
  const calls = [];
  const rec = (name, value) => (...args) => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    calls,
    log: () => {},
    sleep: () => Promise.resolve(),
    httpJson: rec("httpJson", { status: 200, body: { mode: "PRIMARY", reasons: [] } }),
    redisCall: rec("redisCall", null),
    pauseRedis: rec("pauseRedis"),
    unpauseRedis: rec("unpauseRedis"),
    sqliteRows: rec("sqliteRows", []),
    findGoPid: rec("findGoPid", [1234]),
    signalPid: rec("signalPid"),
    probeBlockedApproval: rec("probeBlockedApproval", { ok: true, status: 503 }),
    writeEvidence: rec("writeEvidence", "/tmp/evidence.json"),
  };
}

describe("E06-T02-S1 flags + safety rails", () => {
  it("parses drills, phases and local endpoints", () => {
    const f = parseArgs(["go", "--phase", "kill", "--execute", "--target", "local", "--hard", "--db", "/tmp/x.sqlite"], {});
    assert.equal(f.drill, "go");
    assert.equal(f.phase, "kill");
    assert.equal(f.execute, true);
    assert.equal(f.hard, true);
    assert.equal(f.db, "/tmp/x.sqlite");
    assert.deepEqual(DRILLS, ["go", "redis", "both", "rejoin", "budget"]);
    assert.equal(parseArgs([], {}).workers, "http://127.0.0.1:8787");
  });

  it("a dry run needs no target; --execute does", () => {
    assert.equal(guard(parseArgs(["go"], {}), {}), null);
    assert.match(guard(parseArgs(["go", "--execute"], {}), {}), /--target local/);
    assert.equal(guard(parseArgs(["go", "--execute", "--target", "local"], {}), {}), null);
  });

  it("refuses non-local hosts, unknown drills/phases and live-trading flags", () => {
    const remote = parseArgs(["go", "--execute", "--target", "local", "--workers", "https://api.example.com"], {});
    assert.match(guard(remote, {}), /non-local/);
    assert.match(guard(parseArgs(["nuke"], {}), {}), /unknown drill/);
    assert.match(guard(parseArgs(["go", "--phase", "nuke"], {}), {}), /unknown phase/);
    assert.match(guard(parseArgs(["go"], {}), { LIVE_TRADING_ENABLED: "1" }), /LIVE_TRADING_ENABLED/);
    assert.match(guard(parseArgs(["go"], {}), { ENV: "prod" }), /ENV=prod/);
    assert.equal(guard(parseArgs(["go"], {}), { ENV: "dev" }), null);
  });

  it("host + address helpers know the local allowlist", () => {
    assert.equal(hostOf("http://127.0.0.1:8787"), "127.0.0.1");
    assert.equal(hostOf("https://api.toobit.com"), "api.toobit.com");
    assert.equal(hostOf("localhost:6379"), "localhost");
    assert.deepEqual(splitHostPort("127.0.0.1:6379"), ["127.0.0.1", 6379]);
    assert.deepEqual(splitHostPort("localhost"), ["localhost", 6379]);
  });

  it("dry run touches nothing (no socket, no signal, no write)", async () => {
    const io = stubIo();
    const res = await run(parseArgs(["both", "--hard"], {}), io, {});
    assert.equal(res.dryRun, true);
    assert.equal(res.touched, false);
    assert.equal(res.ok, true);
    assert.deepEqual(io.calls, []);
    assert.ok(res.plan.length > 4);
  });

  it("a refused run touches nothing either", async () => {
    const io = stubIo();
    const res = await run(parseArgs(["go", "--execute"], {}), io, {});
    assert.equal(res.ok, false);
    assert.match(res.reason, /--target local/);
    assert.deepEqual(io.calls, []);
  });

  it("every drill has a plan with an action step and assertions", () => {
    for (const d of DRILLS) {
      const plan = planFor(parseArgs([d], {}));
      assert.ok(plan.length >= 3, `${d} plan too short`);
      assert.ok(plan.some((s) => /kill|stub exchange/.test(s)), `${d} plan has no action step`);
    }
    assert.match(planFor(parseArgs(["budget"], {})).join(" "), /ADR-004/);
  });
});

describe("E06-T02-S1 RESP codec + drill assertions", () => {
  it("builds and parses RESP replies", () => {
    assert.equal(respCommand(["PING"]), "*1\r\n$4\r\nPING\r\n");
    assert.equal(parseReply("+OK\r\n").value, "OK");
    assert.equal(parseReply(":3\r\n").value, "3");
    assert.equal(parseReply("$3\r\nfoo\r\n").value, "foo");
    assert.equal(parseReply("$-1\r\n").value, null);
    assert.deepEqual(parseReply("*2\r\n$1\r\na\r\n$1\r\nb\r\n").value, ["a", "b"]);
    assert.equal(parseReply("*2\r\n$1\r\na\r\n$1\r\nb\r\n").next, 18);
    assert.throws(() => parseReply("+OK"), /truncated/);
    assert.throws(() => parseReply("-ERR nope\r\n"), /redis error/);
    assert.throws(() => parseReply("?weird\r\n"), /RESP/);
  });

  it("rows complete needs every component", () => {
    const rows = COMPONENTS.map((c) => ({ component: c }));
    assert.equal(assertRowsComplete(rows).ok, true);
    const short = assertRowsComplete(rows.filter((r) => r.component !== "lease"));
    assert.equal(short.ok, false);
    assert.deepEqual(short.detail.missing, ["lease"]);
  });

  it("duplicate intents are caught (§6.4)", () => {
    assert.equal(assertZeroDupIntents([{ approval_id: "a1" }, { approval_id: "a2" }]).ok, true);
    const dup = assertZeroDupIntents([{ approval_id: "a1" }, { approval_id: "a1" }]);
    assert.equal(dup.ok, false);
    assert.deepEqual(dup.detail.duplicates, ["a1 x2"]);
  });

  it("watch-set equality is two-directional (§6.6)", () => {
    assert.equal(assertWatchSetEqual(["w1", "w2"], ["w2", "w1"]).ok, true);
    const short = assertWatchSetEqual(["w1"], ["w1", "w2"]);
    assert.equal(short.ok, false);
    assert.deepEqual(short.detail.onlyD1, ["w2"]);
    assert.deepEqual(assertWatchSetEqual(["w1", "w9"], ["w1"]).detail.onlyRedis, ["w9"]);
  });

  it("rejoin order requires the reconcile incident first (acceptance 2)", () => {
    const mode = [{ status: "DEGRADED", at: "2026-10-11T10:00:00Z" }, { status: "PRIMARY", at: "2026-10-11T10:02:00Z" }];
    assert.equal(assertRejoinOrder(mode, [{ incident: "reconcile.complete", at: "2026-10-11T10:01:00Z" }]).ok, true);
    const late = [{ incident: "reconcile.complete", at: "2026-10-11T10:03:00Z" }];
    assert.equal(assertRejoinOrder(mode, late).ok, false);
    assert.match(assertRejoinOrder(mode, []).detail.reason, /no reconcile\.complete/);
    assert.match(assertRejoinOrder([], []).detail.reason, /no PRIMARY mode row/);
  });

  it("mode timeline must leave PRIMARY and come back", () => {
    const seq = [{ status: "PRIMARY" }, { status: "DEGRADED" }, { status: "FALLBACK" }, { status: "PRIMARY" }];
    assert.equal(assertModeTimeline(seq).ok, true);
    assert.deepEqual(assertModeTimeline(seq).detail.sequence, ["PRIMARY", "DEGRADED", "FALLBACK", "PRIMARY"]);
    assert.equal(assertModeTimeline([{ status: "PRIMARY" }, { status: "PRIMARY" }]).ok, false);
  });

  it("no-backoff alert flags any rate_limit_backoff incident", () => {
    assert.equal(assertNoBackoffAlert([{ incident: "mode:DEGRADED" }]).ok, true);
    assert.equal(assertNoBackoffAlert([{ incident: "rate_limit_backoff" }]).ok, false);
  });

  it("budget math follows ADR-004 (10 and 100 symbols @5s hold)", () => {
    assert.equal(budgetFloorSec(10), 0.4);
    assert.equal(budgetFloorSec(100), 4);
    assert.equal(assertBudget({ symbols: 10, pollSec: 5 }).ok, true);
    assert.equal(assertBudget({ symbols: 100, pollSec: 5 }).ok, true);
    assert.equal(assertBudget({ symbols: 100, pollSec: 5, pollsPerRound: 100 }).ok, true);
    // below the floor, and over the weight budget
    assert.equal(assertBudget({ symbols: 100, pollSec: 1 }).ok, false);
    assert.equal(assertBudget({ symbols: 100, pollSec: 5, pollsPerRound: 100, weightPerPoll: 50 }).ok, false);
  });

  it("evidence files are per-drill and UTC-stamped", () => {
    const at = new Date("2026-10-11T10:20:30.400Z");
    assert.equal(evidenceName("both", at), "both-2026-10-11T10-20-30-400Z.json");
    const ev = renderEvidence({ drill: "go", phase: "all", flags: { target: "local" }, checks: [{ name: "x", ok: true }], at });
    assert.equal(ev.task, "E06-T02");
    assert.equal(ev.ok, true);
    assert.equal(ev.drill, "go");
    const bad = renderEvidence({ drill: "go", phase: "all", flags: {}, checks: [{ name: "x", ok: false }], at });
    assert.equal(bad.ok, false);
  });
});
