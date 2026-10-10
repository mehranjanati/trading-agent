# 12 — Deployment & Operations Runbook

## 12.1 Environments (separate everything)
| | dev | staging | prod (paper-only until gate) |
|---|---|---|---|
| D1 | `trading_dev` | `trading_stg` | `trading_prod` |
| Toobit keys | testnet/paper | testnet | testnet until signed gate |
| Redis | local/docker | Hetzner small | Hetzner prod |
| Deploy | auto on PR merge | manual | manual + two-person + green P0 |
Prod deploys blocked while kill switch engaged or P0 gates red.

## 12.2 Deploy procedures
- **Go (Hetzner):** build binary → health-gated rolling restart (systemd/docker) → `/readyz` 200 → announce. Rollback: previous binary + `recovery_log` entry, <5min.
- **Workers:** `wrangler deploy --env <env>` after `d1 migrations apply --preview`; D1 migrate first, code second. Rollback: redeploy prior version (migrations forward-fix only).
- **Dashboard:** Pages auto-deploy per env; verify badges on staging before prod.

## 12.3 Backup & restore
D1 PITR per Cloudflare docs (record RPO proof quarterly); Redis RDB+AOF snapshots hourly; `strategy_configs` export per change. Restore drill quarterly (E12).

## 12.4 Incident response (1-2-3-4-5)
1. Engage kill switch if any risk of unapproved/duplicate orders. 2. Set mode banner + open incident in `recovery_log`. 3. Triage per §06 playbooks. 4. Reconcile all non-terminal intents. 5. Postmortem within 48h → ADR update if design gap.

## 12.5 Key rotation
Rotate Toobit keys every 90d: create new → dual-run reconcile → revoke old → log. Approval-token secret rotation needs deploy + 10-min overlap (expiry window).
