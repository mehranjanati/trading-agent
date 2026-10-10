# 00 — Project Charter: Independent AI Trading Agent (Toobit USDT-M Futures)

**Status:** PROPOSED | **Date:** 2026-10-10 | **Owner:** Human approver

## 1. Vision
Build a reliable, observable, recoverable, secure futures-trading assistant — not a script that submits orders.

## 2. Goals (G-01..G-06)
- G-01 Reliable Watch→signal→analysis→approval→order→reconcile loop.
- G-02 Full observability: health, freshness, latency, audit timeline.
- G-03 Safe failover primary (Go+Redis) ↔ fallback (Workers/DO/D1+REST).
- G-04 Human approval before every new order (initial mode).
- G-05 Deterministic risk enforcement independent of AI output.
- G-06 Independent deployable repo; no merge into SaaS/EdgeTune.

## 3. Scope (in)
- Toobit USDT-M Futures market-data WS connector, Price Watcher, Redis state.
- Workers control plane, D1 canonical state, DO coordination, dashboard.
- Signal ingestion (triple divergence, order blocks, OB/OS, MTF, regime/invalidation).
- Approval workflow, risk engine, execution + reconciliation (test-gated).

## 4. Non-goals
- No live trading without explicit human release gate. No withdrawals. No guaranteed profitability claims. No tick store in D1.

## 5. Actors
Human Trader (approver), Operator, Risk Engine (deterministic), AI Analyst (advisory), Go Watcher, Exchange (Toobit).

## 6. Initial operating mode
`HUMAN_APPROVAL_REQUIRED=true`. Every new order needs human approve. Fail-closed on uncertainty (SAFE-001). No auto-trading flag exists in MVP.

## 7. Success criteria
- S-01 Paper-trade loop runs 14d with zero unapproved orders.
- S-02 Failover drill recovers Watches from D1 without duplicate orders.
- S-03 Dashboard distinguishes live/stale/cached/unavailable 100% of incident time.
- S-04 All P0 gates in `tasks/TEST-AND-RELEASE-GATES.md` pass.

## 8. Constraints & links
- Safety: `08-trading-risk-and-execution-safety.md` (SAFE-001..). Reqs: `01-product-requirements.md`. Arch: `02-system-architecture.md`.
