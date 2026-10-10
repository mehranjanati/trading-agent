# 01 — Product Requirements

## Functional (FR-001..)
- FR-001 Create/cancel Watch (symbol, trigger, invalidation, expiry). G/W/T: Given valid symbol When created Then persisted in D1 + cached in Redis + visible in dashboard.
- FR-002 Stream normalized prices with timestamps; expose freshness.
- FR-003 Fire trigger events with stable IDs, deduplicated.
- FR-004 Ingest external signals (divergence, OB, OS, MTF, regime).
- FR-005 Run AI analysis producing structured rationale + confidence, never an order.
- FR-006 Human approval center: approve/reject with reason, expiry, single-use.
- FR-007 Deterministic risk validation before any order intent.
- FR-008 Order intent → idempotent submit → reconcile with Toobit until terminal.
- FR-009 Position snapshots + PnL from reconciled fills.
- FR-010 Failover: load Watches from D1, REST-poll rate-limited, block orders if uncertain.
- FR-011 Dashboard views (11 listed in charter §dashboard) incl. health + audit timeline.
- FR-012 Kill switch halts new orders in <5s, records actor + reason.

## Non-functional (NFR-001..)
- NFR-001 Freshness: dashboard shows data age; stale threshold per symbol (default 5s).
- NFR-002 Availability: control API + dashboard independent from execution availability.
- NFR-003 Recoverability: RPO=zero for D1 business state; RTO primary <5min, fallback degraded <2min.
- NFR-004 Auditability: every state transition has event/audit row.
- NFR-005 Security: no secrets in repo; least-privilege Toobit keys (no withdrawals).
- NFR-006 Rate compliance: never exceed documented Toobit limits (VERIFY_REQUIRED).

## User journeys
J1 Trader creates Watch → trigger → analysis → approves → order reconciled. J2 Operator drills Go loss → fallback banner → recovery. J3 Risk rejects over-leverage → trader sees reason.

## MVP boundary
IN: paper/testnet loop, approval, risk, failover drill. OUT: live trading, auto-trading, withdrawals, backtest-profit claims.
