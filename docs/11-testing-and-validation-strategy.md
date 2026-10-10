# 11 — Testing & Validation Strategy

- Unit: FSM guards, risk gates, dedupe, lease logic (cov ≥80% on safety paths).
- Integration: Go→Redis→Worker→D1 with test doubles; outbox relay; reconcile mock.
- Contract: event schema validation, API snapshots.
- Replay: recorded ticks → deterministic trigger tests.
- Load: 2× target symbols throughput; WS flap; Redis eviction.
- Security: authz matrix, secret-scan, dep audit.
- Recovery: kill Go, kill Redis, kill both, D1 outage drill; assert no duplicate orders + audit rows.
- Paper-trading: ≥14d testnet with approvals; gate for any live talk.
