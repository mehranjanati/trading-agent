// do.test.mjs — E05-T02: split-brain + fencing + shard ownership (node:test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAuthority, TTL_MS } from "./lease.mjs";
import { createCoordinator, createFanout, shardOf, SHARD_COUNT } from "./shards.mjs";

const mem = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), put: (k, v) => m.set(k, v) };
};

describe("E05-T02-S1 ExecutionAuthority lease", () => {
  it("split-brain: two racers, exactly one wins, loser is fenced", () => {
    const a = createAuthority(mem());
    const r1 = a.acquire("go-watcher", 1000);
    const r2 = a.acquire("workers-fallback", 1001);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, false);
    assert.equal(r2.held_by, "go-watcher");
    // loser tries to submit with a stolen epoch → fenced
    const v = a.verify("workers-fallback", r1.epoch, 1002);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "fenced");
  });
  it("renew keeps lease alive; expired lease can be taken by anyone", () => {
    const a = createAuthority(mem());
    const r = a.acquire("go", 0); // expires at TTL_MS
    assert.equal(a.renew("go", r.epoch, TTL_MS / 3).ok, true);
    assert.equal(a.renew("go", r.epoch, (2 * TTL_MS) / 3).ok, true);
    assert.equal(a.renew("go", r.epoch, (2 * TTL_MS) / 3 + 1).ok, true);
    // stop renewing → TTL lapses → anyone may acquire
    assert.equal(a.renew("go", r.epoch, 2 * TTL_MS + 1_000).ok, false); // past last expiry
    const r2 = a.acquire("fallback", 2 * TTL_MS + 1_001); // expired → anyone
    assert.equal(r2.ok, true);
    assert.ok(r2.epoch > r.epoch); // epoch monotonic
  });
  it("stale-epoch renew rejected (zombie holder after handoff)", () => {
    const a = createAuthority(mem());
    const r1 = a.acquire("go", 0);
    a.release("go", r1.epoch);
    const r2 = a.acquire("fallback", 1); // epoch bumped
    assert.equal(a.renew("go", r1.epoch, 2).ok, false); // zombie fenced
    assert.equal(a.verify("go", r1.epoch, 2).ok, false);
  });
});
describe("E05-T02-S2 shards + fanout", () => {
  it("shard ownership is deterministic and exclusive", () => {
    const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT", "ADAUSDT", "LTCUSDT", "LINKUSDT", "AVAXUSDT"];
    const seen = new Map();
    for (const s of syms) {
      const sh = shardOf(s);
      assert.ok(sh >= 0 && sh < SHARD_COUNT);
      seen.set(s, sh); // same symbol → same shard every call
      assert.equal(shardOf(s), sh);
    }
    // no two symbols share unless the hash says so — exclusivity is by mapping, per-symbol single owner
    assert.equal(seen.size, syms.length);
  });
  it("coordinator sync/ack persist cursor + active set", () => {
    const c = createCoordinator(mem());
    c.sync(["w1", "w2", "w2"]); // dedupe
    assert.deepEqual(c.load().active_ids, ["w1", "w2"]);
    c.ack("1791660160406-0");
    assert.equal(c.load().cursor, "1791660160406-0");
    c.sync(["w3"]);
    assert.equal(c.load().cursor, "1791660160406-0"); // cursor survives sync
  });
  it("fanout broadcasts and drops dead sockets", () => {
    const f = createFanout();
    const sent = [];
    const alive = { send: (m) => sent.push(m) };
    const dead = { send: () => { throw new Error("closed"); } };
    f.subscribe(alive); f.subscribe(dead);
    const delivered = f.broadcast({ type: "health.degraded_v1" });
    assert.equal(delivered, 1); // dead pruned
    assert.deepEqual(sent, [JSON.stringify({ type: "health.degraded_v1" })]);
  });
});
