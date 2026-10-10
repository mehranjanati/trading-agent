# 07 — Security & Threat Model (STRIDE-lite + controls)

## 7.1 Assets & trust zones
Assets: Toobit trade keys, approval tokens, D1 business state, lease authority, audit log. Zones: public internet / Hetzner host / Cloudflare account / operator laptop. Secrets never touch repo, issues, logs or dashboard.

## 7.2 Threats → mitigations (T-01..T-08)
- **T-01 Key theft** → trade-only keys (withdrawals disabled at exchange), IP allowlist, Cloudflare secret store + Hetzner vault, 90-day rotation, kill switch. Detect: anomalous IP/order velocity alert.
- **T-02 Forged signal/order** → OIDC/JWT + RBAC (trader/operator/admin), separation of duties (approver ≠ submitter operator), schema validation, idempotency keys.
- **T-03 Replay / double-submit** → `client_order_id` UNIQUE, single-use approvals (`used_at`), lease epoch fencing, dedupe on `dedupe_key`.
- **T-04 Poisoned market data** → freshness gates (R-STALE), REST refresh before order, tick sanity bounds (reject >2% jump without confirmation), multi-tick confirmation.
- **T-05 Dashboard/auth leak** → HttpOnly session, CSP, rate limits (100/min/IP), minimal PII, audit of logins/approvals.
- **T-06 Supply chain** → pinned deps + lockfiles, image digests, `npm audit`/`go vet` in CI, Dependabot.
- **T-07 Operator error** → confirm-step for kill switch/release, dry-run for migrations, two-person rule for prod deploys.
- **T-08 D1/DO compromise** → least-privilege tokens, per-env databases, PITR backups, append-only audit (no UPDATE/DELETE on `events`).

## 7.3 Key management
Toobit keys: trade-only, no withdrawal, IP-restricted, per-env, stored in secret manager only. Rotation runbook in §12. Approval tokens: random 256-bit, single-use, 10-min TTL. Lease holder IDs: unguessable.

## 7.4 Network & API abuse
WAF + rate limits on `/api/*`; approval endpoints 10/min/user; order intents 5/min/user; webhook HMAC verification; clock-skew reject >30s.

## 7.5 Audit & access reviews
Every approval/order/kill/lease event logs actor+IP+time. Quarterly access review (Q-06 owners). Secret-scan CI blocks key-shaped strings.
