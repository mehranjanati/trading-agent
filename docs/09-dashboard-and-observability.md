# 09 — Dashboard & Observability

## IA (routes)
`/ overview+health` `/signals` `/watches` `/zones` `/events` `/analysis` `/approvals` `/orders` `/failover` `/logs` `/strategy`. Each shows freshness badge: LIVE (<5s) / STALE / CACHED / UNAVAILABLE.

## Metrics/logs/alerts
- Metrics: ws_uptime, tick_lag_ms, stream_lag, trigger→approval p50/p95, reconcile_time, risk_rejects, fallback_minutes. Logs: structured JSON, trace evt_id. Alerts: heartbeat loss, stale >30s, SUBMIT_UNKNOWN>5min, D1 errors, kill-switch.

## Degraded UX
- Persistent banner with mode + limitations; disable order buttons with reason tooltip when uncertain; timelines show gaps explicitly.
