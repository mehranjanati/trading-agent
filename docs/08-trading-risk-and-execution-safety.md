# 08 — Trading Risk & Execution Safety

## Safety reqs (SAFE-001..)
- SAFE-001 Fail closed on uncertain price/approval/state/order outcome.
- SAFE-002 Human approval (single-use, expiring) before every new order in initial mode.
- SAFE-003 Deterministic risk gates independent of AI: max leverage, max notional, max concurrent, allowlisted symbols, freshness, kill-switch off.
- SAFE-004 Idempotent submit (`clientOrderId=intent_id`), reconcile-to-terminal, never blind retry.
- SAFE-005 Kill switch halts new orders <5s.
- SAFE-006 No withdrawals; trade-only keys.
- SAFE-007 Paper/testnet validation required before any live enablement.
- SAFE-008 No profitability guarantees from backtests.

## Approval workflow
Request → notify → approve/reject+reason → single-use token → risk → intent. Expiry default 10min.

## Unknown outcome
`SUBMIT_UNKNOWN` → poll `GET order` by clientOrderId with backoff → ACKED/FILLED/REJECTED; alert if >5min unresolved.
