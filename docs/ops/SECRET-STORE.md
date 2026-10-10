# Secret-Store Wiring (no secrets in repo — E01-T01-S2)

## Cloudflare Workers (per env: dev / staging / prod)
```bash
# set once per env, values never touch git
wrangler secret put TOOBIT_API_KEY --env dev
wrangler secret put TOOBIT_API_SECRET --env dev
wrangler secret list --env dev   # names only, never values
```
Code reads via binding/env: `env.TOOBIT_API_KEY`. Local dev uses `.dev.vars` (gitignored) with `testnet-dummy` values only.

## Hetzner Go + Redis
- Go env from systemd `EnvironmentFile=/etc/trading-agent/env` (root-only, `0600`), populated from vault at provision time.
- Redis password via `requirepass` from the same vault path; `REDIS_URL` embeds nothing in repo.
- Rotation (§12.5): new key → dual-run reconcile → revoke old → `recovery_log` row.

## Rules
1. `grep -r` for a secret value must return zero hits outside vault/secret-store (CI enforces shape scan).
2. Approval tokens: 256-bit random, 10-min TTL, single-use — generated at runtime, never seeded.
3. Key policy: trade-only, withdrawals disabled at exchange, IP allowlist, 90-day rotation (see E01-T02 for full policy).

Related: [Config matrix](./CONFIG-MATRIX.md) · [Runbook §12.5](../12-deployment-and-operations-runbook.md).
