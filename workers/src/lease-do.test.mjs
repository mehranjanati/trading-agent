// lease-do.test.mjs — E12-T01: ExecutionAuthority DO unit tests.
// Mocks DO state.storage + setAlarm; env.DB is optional (absent here, so
// syncToD1 is a no-op — D1-backed readLease() is covered by rejoin.test.mjs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExecutionAuthority } from "./do.mjs";
import { HOLDERS, TTL_MS } from "./lease.mjs";

const storage = () => {
  const m = new Map();
  let alarmTime = null;
  return {
    storage: {
      get: (k) => m.get(k),
      put: (k, v) => m.set(k, v),
      setAlarm: (t) => { alarmTime = t; },
    },
    alarm: () => alarmTime,
  };
};

const env = () => ({});
const makeDo = (st = storage(), e = env()) => new ExecutionAuthority(st, e);

describe("E12-T01 ExecutionAuthority DO — durable + alarm self-renewal", () => {
  it("acquire persists to DO storage and sets an alarm", async () => {
    const st = storage();
    const doa = makeDo(st);
    const now = Date.now();
    const res = await doa.fetch(new Request("http://x/acquire", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.holder, HOLDERS.PRIMARY);
    assert.ok(body.expires_ms > now, "lease gets a TTL");
    assert.equal(JSON.parse(st.storage.get("lease")).holder, HOLDERS.PRIMARY, "persisted to DO storage");
    assert.ok(st.alarm() > now, "alarm set after acquire");
  });

  it("renew while held extends expires_ms without bumping epoch", async () => {
    const st = storage();
    const doa = makeDo(st);
    const now = Date.now();
    const g = await doa.fetch(new Request("http://x/acquire", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY }),
    }));
    const granted = await g.json();
    const epoch1 = granted.epoch;

    await new Promise((r) => setTimeout(r, 50));
    const r = await doa.fetch(new Request("http://x/renew", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY, epoch: epoch1 }),
    }));
    const renewed = await r.json();
    assert.equal(renewed.ok, true);
    assert.equal(renewed.epoch, epoch1, "epoch unchanged on renew");
    assert.ok(renewed.expires_ms > granted.expires_ms, "expires_ms extended");
    assert.ok(st.alarm() > now, "alarm reset after renew");
  });

  it("renew with stale epoch is rejected", async () => {
    const st = storage();
    const doa = makeDo(st);
    const now = Date.now();
    const g = await doa.fetch(new Request("http://x/acquire", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY }),
    }));
    const granted = await g.json();

    // Simulate another holder taking over with a higher epoch.
    await st.storage.put("lease", JSON.stringify({
      holder: HOLDERS.FALLBACK, epoch: granted.epoch + 1,
      expires_ms: now + TTL_MS,
    }));

    const r = await doa.fetch(new Request("http://x/renew", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY, epoch: granted.epoch }),
    }));
    const renewed = await r.json();
    assert.equal(renewed.ok, false);
    assert.equal(renewed.reason, "stale-epoch");
  });

  it("verify with correct epoch passes, wrong epoch is fenced", async () => {
    const st = storage();
    const doa = makeDo(st);
    const now = Date.now();
    const g = await doa.fetch(new Request("http://x/acquire", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY }),
    }));
    const granted = await g.json();

    assert.equal((await (await doa.fetch(new Request("http://x/verify", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY, epoch: granted.epoch }),
    }))).json()).ok, true);

    const bad = await (await doa.fetch(new Request("http://x/verify", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY, epoch: granted.epoch + 999 }),
    }))).json();
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "fenced");
  });

  it("alarm() auto-renews a live lease", async () => {
    const st = storage();
    const doa = makeDo(st);
    const now = Date.now();
    await doa.fetch(new Request("http://x/acquire", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.PRIMARY }),
    }));
    const before = JSON.parse(st.storage.get("lease"));
    const beforeExpires = before.expires_ms;

    // Small delay so Date.now() advances past the acquire timestamp,
    // ensuring renew() sets a strictly later expires_ms.
    await new Promise((r) => setTimeout(r, 10));

    await doa.alarm();
    const after = JSON.parse(st.storage.get("lease"));
    assert.ok(after.expires_ms > beforeExpires, "alarm renewed the lease");
    assert.equal(after.epoch, before.epoch, "alarm renew does not bump epoch");
    assert.ok(st.alarm() > now, "alarm sets next alarm");
  });

  it("alarm() does not renew an expired lease", async () => {
    const st = storage();
    const doa = makeDo(st);
    const now = Date.now();
    await st.storage.put("lease", JSON.stringify({
      holder: HOLDERS.PRIMARY, epoch: 1, expires_ms: now - TTL_MS,
    }));
    await doa.alarm();
    const cur = JSON.parse(st.storage.get("lease"));
    assert.equal(cur.expires_ms, now - TTL_MS, "expired lease not touched by alarm");
    assert.equal(cur.holder, HOLDERS.PRIMARY, "holder not cleared by alarm (explicit handoff required)");
  });

  it("alarm() when no lease exists is a no-op", async () => {
    const st = storage();
    const doa = makeDo(st);
    await doa.alarm();
    assert.equal(st.storage.get("lease"), undefined, "no lease created by alarm");
  });

  it("acquire after expiry succeeds (recovery path)", async () => {
    const st = storage();
    const doa = makeDo(st);
    const now = Date.now();
    await st.storage.put("lease", JSON.stringify({
      holder: HOLDERS.PRIMARY, epoch: 3, expires_ms: now - TTL_MS,
    }));
    const res = await doa.fetch(new Request("http://x/acquire", {
      method: "POST", body: JSON.stringify({ holder: HOLDERS.FALLBACK }),
    }));
    const body = await res.json();
    assert.equal(body.ok, true, "expired lease can be acquired by another holder");
    assert.equal(body.epoch, 4, "epoch bumps on recovery acquire");
  });
});
