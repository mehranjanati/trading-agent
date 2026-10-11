// do.mjs — E05-T02: Durable Object classes (ExecutionAuthority, WatchCoordinator,
// DashboardFanout). Logic in lease.mjs/shards.mjs; DO runtime supplies storage.
import { createAuthority } from "./lease.mjs";
import { createCoordinator, createFanout, shardOf, SHARD_COUNT } from "./shards.mjs";

const mem = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), put: (k, v) => m.set(k, v) };
};

// Singleton: one ExecutionAuthority per environment (exported class for wrangler).
export class ExecutionAuthority {
  constructor(_state, _env) { this.impl = createAuthority(mem()); }
  async fetch(req) {
    const u = new URL(req.url);
    const b = await req.json().catch(() => ({}));
    const now = Date.now();
    if (u.pathname === "/acquire") return Response.json(this.impl.acquire(b.holder, now));
    if (u.pathname === "/renew") return Response.json(this.impl.renew(b.holder, b.epoch, now));
    if (u.pathname === "/verify") return Response.json(this.impl.verify(b.holder, b.epoch, now));
    if (u.pathname === "/release") return Response.json(this.impl.release(b.holder, b.epoch));
    return Response.json({ code: "NOT_IMPLEMENTED" }, { status: 501 });
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
      // WebSocketPair wiring is runtime-specific; handled by wrangler in prod.
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
