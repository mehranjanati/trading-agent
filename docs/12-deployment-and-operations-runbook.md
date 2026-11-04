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

## 12.6 Live-enable procedure (GATED — do not run until docs/21 §21.9 is signed)

The venue adapter is paper-only today (D-06). Going live is a **two-person**
operation, not a deploy knob; the full gate plan is [docs/21](./21-live-trading-readiness.md)
and the decision record is [ADR-013](./decisions/ADR-013-live-execution-adapter.md).

1. Confirm every box in docs/21 §21.9 is ticked and the `paper-gate` report is
   attached to the release record (SAFE-007: 14 consecutive days, zero unapproved
   orders, zero duplicate `client_order_id`, every intent reconciled to terminal).
2. Second reviewer independently re-reads the report and the risk-gate diff
   (there must be **no** risk-gate diff) — SAFE-010 separation of duties.
3. `wrangler secret put TOOBIT_API_KEY` / `TOOBIT_API_SECRET` for the `live` env
   (trade-only keys, withdrawals disabled, IP allowlist = Workers egress).
4. Set `ENV=live` **and** `LIVE_TRADING_ENABLED=true` in the same deploy, plus
   `TOOBIT_RECV_WINDOW`, `POSITION_MODE`, `MARGIN_TYPE` (Q-15). A half-configured
   deploy must fail at boot, and that failure is the expected outcome of step 4 in
   rehearsal — rehearse it once before the real flip.
5. Verify `GET /api/health.execution_venue === "toobit-live"` and that the
   dashboard banner shows the live venue **before** placing anything.
6. First order: smallest allowed notional on one major (Q-16), supervised, then
   exercise the kill switch immediately after the fill.

Rollback (< 5 min, docs/21 §21.8): kill switch → flatten exposure → flip
`LIVE_TRADING_ENABLED=false` + redeploy → revoke keys at the venue → reconcile all
non-terminal intents → one `recovery_log` row naming actor + reason.
