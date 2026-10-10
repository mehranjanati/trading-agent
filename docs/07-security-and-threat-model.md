# 07 — Security & Threat Model

## Threats (T-01..)
- T-01 Stolen Toobit keys → Mit: no-withdraw, IP allowlist, secret store, rotation, kill switch.
- T-02 Forged signal/order → Mit: auth (JWT/OIDC), RBAC (trader/operator/admin), idempotency, server-side risk.
- T-03 Replay/double-submit → Mit: clientOrderId UNIQUE, single-use approvals, lease fencing.
- T-04 Poisoned market data → Mit: freshness gates, multi-source refresh before order, anomaly reject.
- T-05 Dashboard leak → Mit: minimal PII, audit log, rate-limit, CSP.
- T-06 Supply-chain → Mit: pinned deps, lockfiles, image digests, CI SAST.

## Rules
- No secrets in repo/issues/logs. Toobit keys: trade-only, no withdrawals, IP-restricted. Human auth required for approvals. All order paths logged with actor. Abuse: per-IP rate limits, approval expiry, kill switch.
