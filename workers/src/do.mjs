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

// NOTE: DO state.storage is ASYNC (get/put return Promises), while the pure
// state machine in lease.mjs is synchronous — so every request hydrates a
// memory map from an awaited read, runs the operation, then flushes any change
// back (the same pattern health-route.withAuthority uses over the D1 row).
// Getting this wrong is silent in a sync mock and fatal in production:
// JSON.parse(String(promise)) throws `Unexpected token 'o', "[object Promise]"`.

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
  }

  /** Hydrate → run → flush. `fn` receives the sync state machine; a changed
   *  lease is persisted to DO storage, mirrored to D1 and the mid-TTL
   *  self-renewal alarm is re-armed. Returns whatever `fn` returned. */
  async apply(fn) {
    const stored = (await this.state.storage.get("lease")) ?? null; // JSON string
    const mem = { lease: stored };
    const impl = createAuthority({ get: (k) => mem[k] ?? null, set: (k, v) => { mem[k] = v; } });
    const out = fn(impl);
    if (mem.lease !== stored) {
      await this.state.storage.put("lease", mem.lease);
      await syncToD1(impl, this.env);
      const cur = impl.load();
      if (cur && cur.holder) {
        // Next alarm at mid-TTL so the lease survives a missed cron tick.
        await this.state.storage.setAlarm(cur.expires_ms - Math.floor(TTL_MS / 2));
      }
    }
    return out;
  }

  /** Alarm handler — self-renewal before TTL expires. Fired by the DO runtime
   *  after setAlarm(); keeps the lease alive even if the Workers cron misses a
   *  tick (the root cause of permanent lease_expired). A successful renew re-arms
   *  the next alarm inside apply() (mid-TTL); a failed renew retries soon; with
   *  no lease the DO just wakes up later — recovery stays an explicit operator
   *  handoff, never an automatic grab. */
  async alarm() {
    const now = Date.now();
    const out = await this.apply((impl) => {
      const cur = impl.load();
      if (cur && cur.holder && cur.expires_ms > now) return impl.renew(cur.holder, cur.epoch, now);
      return null;
    });
    if (out && out.ok === false) await this.state.storage.setAlarm(now + Math.floor(TTL_MS / 4));
    else if (!out) await this.state.storage.setAlarm(now + TTL_MS);
  }

  async fetch(req) {
    const u = new URL(req.url);
    const b = await req.json().catch(() => ({}));
    const now = Date.now();
    const result = await this.apply((impl) => {
      if (u.pathname === "/acquire") return impl.acquire(b.holder, now);
      if (u.pathname === "/renew") return impl.renew(b.holder, b.epoch, now);
      if (u.pathname === "/verify") return impl.verify(b.holder, b.epoch, now);
      if (u.pathname === "/release") return impl.release(b.holder, b.epoch);
      if (u.pathname === "/handoff") {
        // §6.3 step 4 — mirrors health-route.handoffLease exactly: reusing the
        // holder's own unexpired lease is a no-op; an unexpired lease held by
        // someone else is released first (single global holder), so the winner
        // always gets a strictly greater epoch and the previous holder is
        // fenced from then on.
        const cur = impl.load();
        if (cur && cur.holder === b.holder && cur.expires_ms > now) {
          return { ok: true, ...cur, reused: true };
        }
        if (cur && cur.expires_ms > now) impl.release(cur.holder, cur.epoch);
        return impl.acquire(b.holder, now);
      }
      return null;
    });
    if (!result) {
      return new Response(JSON.stringify({ code: "NOT_IMPLEMENTED" }), { status: 501, headers: { "content-type": "application/json" } });
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
