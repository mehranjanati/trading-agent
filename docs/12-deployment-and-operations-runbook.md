# 12 — Deployment & Operations Runbook

## Envs
`dev` (testnet/paper) / `staging` / `prod` (paper-only until gate). Separate D1 DBs, separate Toobit keys, separate Redis. Prod deploys require approval + green gates.

## Deploy
- Go: systemd/docker on Hetzner, health-gated rollout, rollback to prior binary. Workers: `wrangler deploy` per env with D1 migrations preview. Dashboard: Pages.

## Backup/rollback
- D1: point-in-time per Cloudflare docs (record date); Redis RDB+AOF; configs versioned. Rollback: binary + migration forward-fix (no destructive down).

## Incident
1. Kill switch if risk. 2. Badge mode. 3. Triage per §06. 4. Reconcile unknowns. 5. Postmortem → `recovery_log` + ADR if needed.
