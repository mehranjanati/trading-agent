// do.mjs — E05-T02: Durable Object classes (ExecutionAuthority, WatchCoordinator,
// DashboardFanout). Logic in lease.mjs/shards.mjs; DO runtime supplies storage.
// E12-T01: ExecutionAuthority is now durable (state.storage) and self-renews via
// alarms, so a missed cron tick can no longer leave the system in permanent
// lease_expired. The D1 lease_authority row remains the canonical read path for
// readLease(); the DO writes back to D1 on every state change so both stay in sync.
import { createAuthority, HOLDERS, TTL_MS } from "./lease.mjs";
import { createCoordinator, createFanout, shardOf, SHARD_COUNT } from "./shards.mjs";

const mem = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), put: (k, v) => m.set(k, v) };
};

// Adapter: DO state.storage has get/put; lease.mjs expects get/set.
const doStorage = (state) => ({
  get: (k) => k === "lease" ? state.storage.get("lease") : null,
  set: (k, v) => k === "lease" ? state.storage.put("lease", v) : null,
});

/** Write the in-memory lease back to the D1 health_snapshots row so readLease()
 *  (D1-backed) and the DO stay in sync. No-op when env.DB is unavailable
 *  (local/dev environments without D1). */
async function syncToD1(impl, env) {
  if (!env?.DB) return;
  const cur = impl.load();
  if (!cur) return;
  const detail = JSON.stringify({ holder: cur.holder, epoch: cur.epoch, expires_ms: cur.expires_ms });
  await env.DB.prepare(
    "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('lease_authority','lease_authority',?,?,?) "
      + "ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, at=excluded.at",
  ).bind(cur.holder ?? "nobody", detail, new Date(Date.now()).toISOString()).run();
}

// Singleton: one ExecutionAuthority per environment.
export class ExecutionAuthority {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.impl = null;
  }

  /** Lazily bind the pure state machine to DO durable storage. */
  async ensure() {
    if (this.impl) return;
    this.impl = createAuthority(doStorage(this.state));
  }

  /** Alarm handler — self-renewal before TTL expires. Fired by the DO runtime
   *  after setAlarm(); keeps the lease alive even if the Workers cron misses a
   *  tick (the root cause of permanent lease_expired). */
  async alarm() {
    await this.ensure();
    const cur = this.impl.load();
    const now = Date.now();
    if (cur && cur.holder && cur.expires_ms > now) {
      const renewed = this.impl.renew(cur.holder, cur.epoch, now);
      if (renewed.ok) {
        await syncToD1(this.impl, this.env);
        // Next alarm at mid-TTL of the renewed lease.
        await this.state.storage.setAlarm(renewed.expires_ms - Math.floor(TTL_MS / 2));
      } else {
        // Renewal failed (shouldn't happen while we hold it); retry soon.
        await this.state.storage.setAlarm(now + Math.floor(TTL_MS / 4));
      }
    } else {
      // No active holder or already expired: nothing to auto-renew. An explicit
      // handoff/acquire via fetch() is required to restart authority.
      await this.state.storage.setAlarm(now + TTL_MS);
    }
  }

  async fetch(req) {
    await this.ensure();
    const u = new URL(req.url);
    const b = await req.json().catch(() => ({}));
    const now = Date.now();
    let result;
    if (u.pathname === "/acquire") result = this.impl.acquire(b.holder, now);
    else if (u.pathname === "/renew") result = this.impl.renew(b.holder, b.epoch, now);
    else if (u.pathname === "/verify") result = this.impl.verify(b.holder, b.epoch, now);
    else if (u.pathname === "/release") result = this.impl.release(b.holder, b.epoch);
    else return new Response(JSON.stringify({ code: "NOT_IMPLEMENTED" }), { status: 501, headers: { "content-type": "application/json" } });
    if (result.ok) {
      await syncToD1(this.impl, this.env);
      // Schedule the next self-renewal alarm at mid-TTL so the lease stays
      // alive even if the Workers cron misses a tick.
      const cur = this.impl.load();
      await this.state.storage.setAlarm(cur.expires_ms - Math.floor(TTL_MS / 2));
    }
    return Response.json(result);
  }
}

// Sharded: name `WatchCoordinator-{shardOf(symbol)}`.
export class WatchCoordinator {
  constructor(_state, _env) { this.impl = createCoordinator(mem()); }
  async fetch(req) {
    const u = new URL(req.url);
    const b = await req.json().catch(() => ({}));
    if (u.pathname === "/sync") return Response.json(this.impl.sync(b.active_ids ?? []));
    if (u.pathname === "/ack") return Response.json(this.impl.ack(b.stream_id ?? "0"));
    if (u.pathname === "/state") return Response.json(this.impl.load());
    return Response.json({ code: "NOT_IMPLEMENTED" }, { status: 501 });
  }
}

// Ephemeral fan-out (no durable state; clients replay via Workers API on reconnect).
export class DashboardFanout {
  constructor(_state, _env) { this.fanout = createFanout(); }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return Response.json({ code: "NOT_IMPLEMENTED", note: "ws via runtime upgrade in E10" }, { status: 501 });
    }
    if (url.pathname === "/broadcast") {
      const b = await req.json().catch(() => ({}));
      return Response.json({ delivered: this.fanout.broadcast(b) });
    }
    return Response.json({ code: "NOT_IMPLEMENTED" }, { status: 501 });
  }
}
export { shardOf, SHARD_COUNT };
