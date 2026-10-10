# 03 — Components & Responsibilities

## Go Watcher (Hetzner)
- Owns outbound Toobit public WS, normalize `{symbol,px,ts,src}`, in-memory map, trigger eval, heartbeat `hb:go:{id}` every 5s, exp-backoff reconnect (1s→60s+jitter), stale detector. Exposes Fiber HTTP `/healthz /readyz /watches/cache` for ops only.
- Contract: emits `market.tick_v1`, `watch.triggered_v1` to Redis Streams. Never writes D1 directly.

## Redis
- Structs: `px:{sym}` hash, `watch:active:{id}` hash, Streams `events:*`, consumer groups `cg-workers`. Retention: streams trim ~24h. Recoverable: on boot reload active Watches from Workers snapshot endpoint.

## Workers
- Endpoints: `/api/watches*`, `/api/signals*`, `/api/analysis*`, `/api/approvals*`, `/api/orders*`, `/api/health*`, `/api/recovery*`. Each validates auth, idempotency-key, writes D1 via outbox.

## Durable Objects
- `ExecutionAuthority`: single lease `{holder,epoch,expires}`; only holder may submit orders. `WatchCoordinator-{shard}`: fallback trigger eval. `DashboardFanout`: WS fan-out. Persist: leases, shard cursors. Coordinate-only: prices.

## D1 (canonical)
- Tables per 04-data-model. Owner of truth for Watches, approvals, intents, orders, audit.

## AI Analyst / Risk / Execution
- Analyst: advisory JSON `{bias,confidence,invalidation,refs}`. Risk: deterministic gates (leverage, exposure, approval-valid, freshness, kill-switch). Execution: idempotent submit + reconcile loop.

## Dashboard / Exchange boundary
- Dashboard reads Workers API only; shows live/stale/cached/unavailable. Exchange boundary: public WS (no auth) + signed REST (trade keys, IP allowlist, no withdrawals).
