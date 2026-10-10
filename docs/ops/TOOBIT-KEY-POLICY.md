# Toobit API Key Policy — E01-T02-S2 (binding)

1. **Trade-only.** Keys must have withdrawals disabled at the exchange. Any withdrawal-scoped code is a P0 defect (SAFE-008).
2. **IP allowlist.** Prod keys bound to Hetzner egress IPs + Cloudflare egress where applicable. Non-allowlisted IP use pages the operator (T-01).
3. **Per-env keys.** dev / staging / prod keys are distinct; prod stays on testnet/paper until the signed release gate (E11).
4. **Storage.** Secret manager only (§SECRET-STORE). Never in repo, issues, logs, dashboard, or chat transcripts.
5. **Rotation.** Every 90 days or on suspicion: create new → dual-run reconcile → revoke old → `recovery_log` row (see §12.5).
6. **Rate budget.** Fallback poller + reconcile share one token bucket per key; never exceed documented limits (A-02, ADR-004).
7. **Scope最小.** Spot/futures transfer, sub-account, or universal-transfer permissions are NOT granted unless a new ADR + human sign-off adds them.

Audit: quarterly key inventory (owner: operator) + access review (Q-06).
