# 08 — Trading Risk & Execution Safety (normative — overrides all other docs on conflict)

## 8.1 Safety requirements (SAFE-001..SAFE-010)
- **SAFE-001 Fail closed:** uncertain price freshness, approval validity, durable state or order outcome → no new order, record reason, alert.
- **SAFE-002 Human approval:** every new order in initial mode needs single-use, expiring (10m default, Q-05) human approval. No batch pre-approvals.
- **SAFE-003 Deterministic gates:** risk runs in code with fixed limits; AI output is advisory input only and can never widen limits.
- **SAFE-004 Idempotency:** `client_order_id = intent_id`; retries reuse it; duplicates rejected by UNIQUE constraint.
- **SAFE-005 Reconcile-to-terminal:** every intent reaches `FILLED|REJECTED|CANCELLED|EXPIRED` via exchange truth; `SUBMIT_UNKNOWN` reconciles only.
- **SAFE-006 Kill switch:** halts new orders <5s, logs actor+reason, survives restarts (persisted flag).
- **SAFE-007 Paper/testnet proof:** ≥14-day paper run with zero unapproved orders before any live discussion.
- **SAFE-008 No withdrawals:** trade-only keys; any withdrawal-scoped code is a P0 defect.
- **SAFE-009 No profit guarantees:** backtests are not evidence of future returns; never displayed as such.
- **SAFE-010 Separation of duties:** approver ≠ risk-config editor for the same order path.

## 8.2 Risk gate table (codes are user-visible)
| Code | Gate | Default | On reject |
|---|---|---|---|
| R-KILL | kill switch off | off=pass | halt + `kill.engaged` |
| R-APPROVAL | approval valid+unused+unexpired | strict | 410/403 with reason |
| R-SYM | symbol allowlisted | BTC/ETH/SOL allowlist (Q-03 sizes) | reject + suggest |
| R-LEV | leverage ≤ max | 5x | reject with limit/asked |
| R-NOT | notional ≤ max | $1,000/intent (tunable, Q) | reject |
| R-EXP | total exposure ≤ cap | $5,000 | reject |
| R-STALE | price age ≤ threshold | 5s | HOLD + refresh |
| R-DUP | no live intent for same approval | strict | 409 |
Limits live in versioned `strategy_configs`; changes need the **admin** role + audit row (RBAC matrix; SAFE-010 separation of duties).

**Gate semantics (E08-T01, normative):**
1. Gates run in the table order above and the **first failure wins** — a reject is deterministic and reproducible.
2. **Every gate fails closed** (SAFE-001): a missing/unknown input — kill state, approval, symbol, price, open exposure, duplicate state — is a reject, never a pass. An unknown kill state is treated as engaged.
3. Notional and exposure arithmetic is **exact decimal (string) math**, never floats — a boundary like `0.1 × 0.7 = 0.07` must pass exactly.
4. Limits are the active `strategy_configs` version (E07-T01 pinning); every verdict echoes `limits_version` for audit, and a config missing any bound is a `DEGRADED` system fault — no invented defaults (SAFE-003).
5. Gate carries: `R-LEV`/`R-NOT`/`R-EXP` include `limit` + `asked` (J3); `R-SYM` includes the permitted set; `R-STALE` includes `action: "HOLD"`.
6. Rejections surface as `422 RISK_REJECT {risk_code}` (docs/10); the E09 submit path must call this validator — no other gate implementation is allowed.

## 8.3 Approval workflow (states)
`requested → notified → granted|rejected → consumed|expired`. Grant creates token `{approval_id, watch_id, expires_at, nonce}`; consume sets `used_at` atomically (single flight wins, others 409).

## 8.4 Unknown-outcome & duplicate prevention
Timeout/no-response → `SUBMIT_UNKNOWN` → reconcile by `client_order_id` → terminal. Same approval can never mint two intents (UNIQUE on `approval_id` in intents where status != RISK_REJECTED). Same intent can never hit the exchange twice (client ID dedupe + lease epoch).

## 8.5 Kill switch & exposure caps
`POST /api/kill-switch {engaged, reason}` (operator+). Engaged persists in D1 + DO mirror; all submit paths check first. Release needs second human confirm + reason.
