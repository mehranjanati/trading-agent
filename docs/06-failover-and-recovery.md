# 06 — Failover & Recovery

## Health
- Go heartbeat `hb:go` every 5s; Workers marks UNHEALTHY after 3 misses (15s). Redis lag + price-staleness tracked. Status in `health_snapshots` + dashboard badge.
- Determination: Workers cron 10s checks heartbeats + stream lag; records incident in `recovery_log`.

## Scenarios
- Go loss: enter DEGRADED; DO `WatchCoordinator` loads ACTIVE watches from D1; REST-poll; orders blocked unless fresh+approved+risk-pass (rare); banner.
- Redis loss: Go reloads snapshot; Streams resume from last ack; no business loss (D1 truth).
- Both lost: fallback REST only, minimal watch set, no new orders if uncertain (default).
- D1 unavailable: fail-closed orders; reads bannered stale; writes queued in outbox-retry; reconcile paused.
- Stale prices: threshold breach → HOLD triggers, record `HELD_STALE`.

## Leases/fencing
- `ExecutionAuthority` lease 30s, renew 10s, monotonic epoch; submit requires epoch match; old holder fenced. Only one submitter globally.

## Recovery
- Go returns → replays missed transitions, hands back lease via `recovery.coordinate`; fallback drains; verify no divergent intents (reconcile all SUBMIT_UNKNOWN) before PRIMARY badge.
