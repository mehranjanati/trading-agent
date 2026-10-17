# 06 — Failover & Recovery (detect → degrade → recover → rejoin)

## 6.1 Health model
Workers cron every 10s evaluates: Go heartbeat (`hb:go`, 5s cadence, UNHEALTHY after 3 misses = 15s), Redis stream lag (lag >30s = LAG), price staleness per symbol (default 5s, Q-04), D1 error rate, DO lease age. Writes `health_snapshots` + `recovery_log` on change. Dashboard badges: PRIMARY (green) / DEGRADED (amber) / FALLBACK (orange) / HALTED (red, kill switch) / D1-DOWN (grey).

## 6.2 Scenario playbooks
### S1 Go loss
1. Cron declares Go UNHEALTHY → mode DEGRADED, banner + reason. 2. `WatchCoordinator-{shard}` load ACTIVE Watches from D1. 3. REST-poll only watched symbols within budget (ADR-004 math). 4. Triggers need fresh REST quote; else `HELD_UNCERTAIN`. 5. New orders default-blocked (`FALLBACK_ORDERS_ENABLED=false`) unless all of fresh+approved+risk+lease hold.
### S2 Redis loss
1. Go `/readyz` 503, buffers bounded 10k, sheds with gap record. 2. Go reloads snapshot from D1 on Redis return. 3. Workers resume from last-acked stream ID; duplicates deduped. No business loss.
### S3 Both lost
Minimal REST-only watch set (top-N by priority), no new orders if uncertain, full banner. Recovery = S1+S2 combined.
### S4 D1 unavailable
Fail closed for orders; reads bannered CACHED; mutations queued in outbox-retry; reconcile read-only polling; alert immediately.
### S5 Stale prices
Threshold breach → `HELD_STALE`, trigger deferred, auto-retry on fresh tick, visible in timeline.

## 6.3 Leases, fencing, safe return
- Lease: `ExecutionAuthority`, TTL 120s, renew each cron tick, monotonic `epoch`. Every submit includes epoch; mismatch → `lease.fenced` + reject. Only one holder globally.
  (Was 30s/10s: the deployed cron is 1/minute on Cloudflare, so a 30s lease expired between ticks and the §6.3 gate could never pass — `workers/src/lease.mjs`.)
- Return-to-primary: (1) Go healthy 60s continuous, (2) reconcile ALL non-terminal intents, (3) fallback drains (no in-flight evals), (4) lease handoff with epoch bump, (5) mode PRIMARY + `health.recovered` event. Any step fails → stay degraded.

## 6.4 Exchange-accepted-but-ack-lost (critical)
Mark `SUBMIT_UNKNOWN` → poll `GET order by client_order_id` backoff 2s→60s → map to ACKED/FILLED/REJECTED → if absent after 5min: keep polling + page operator; never create a second intent for the same approval (approval already consumed).

## 6.5 Reconciliation inventory (states needing Toobit truth)
`SUBMITTED, SUBMIT_UNKNOWN, ACKED, PARTIAL` intents; `positions` after reconnect; `orders` missing `exchange_order_id`. Swept every 15s + on every recovery.

## 6.6 Restart-without-loss proof
Go+Redis restart must yield identical ACTIVE watch set vs D1 (E03-T02 test) and zero new `evt_` IDs for already-recorded triggers (dedupe test).
