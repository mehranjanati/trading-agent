// shards.mjs — E05-T02-S2: WatchCoordinator shards + DashboardFanout.
// Shard ownership: hash(symbol) % N — a symbol is owned by exactly one shard.
// Coordinators persist {cursor, active_ids}; fanout is ephemeral (replay via API).
export const SHARD_COUNT = 8;
export function shardOf(symbol, n = SHARD_COUNT) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return h % n;
}
export function createCoordinator(storage) {
  // storage: {get(k),put(k,v)} — DO storage for this shard's {cursor, active_ids}
  const load = () => JSON.parse(storage.get("coord") ?? '{"cursor":"0","active_ids":[]}');
  const save = (s) => storage.put("coord", JSON.stringify(s));
  return {
    load,
    /** sync: replace active set (from D1 snapshot); keeps cursor. */
    sync(activeIds) {
      const s = load();
      save({ cursor: s.cursor, active_ids: [...new Set(activeIds)] });
      return load();
    },
    /** ack: advance cursor past a stream ID (fallback eval offset). */
    ack(streamId) {
      const s = load();
      save({ cursor: streamId, active_ids: s.active_ids });
      return load();
    },
  };
}
export function createFanout() {
  const sockets = new Set(); // ephemeral — never persisted
  return {
    subscribe(ws) { sockets.add(ws); return () => sockets.delete(ws); },
    broadcast(msg) {
      const dead = [];
      for (const ws of sockets) {
        try { ws.send(JSON.stringify(msg)); } catch { dead.push(ws); }
      }
      for (const ws of dead) sockets.delete(ws);
      return sockets.size;
    },
    size() { return sockets.size; },
  };
}
