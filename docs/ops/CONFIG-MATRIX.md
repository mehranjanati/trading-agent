# Config Matrix (dev / staging / prod) — E01-T01-S1

Binding rule: every deploy reads secrets from a manager, never from repo files.

| Var | dev | staging | prod (paper-only) | Secret? | Notes |
|---|---|---|---|---|---|
| `ENV` | `dev` | `staging` | `prod` | no | selects D1 DB + Redis |
| `HUMAN_APPROVAL_REQUIRED` | `true` | `true` | `true` | no | hard default, SAFE-002 |
| `FALLBACK_ORDERS_ENABLED` | `false` | `false` | `false` | no | default per ADR-003 |
| `GO_PORT` | `8080` | `8080` | `8080` | no | Hetzner service port |
| `REDIS_URL` | `redis://localhost:6379` | `redis://hetzner-stg:6379` | `redis://hetzner-prod:6379` | passwd part yes | password from vault |
| `TOOBIT_WS_URL` | verify-required placeholder | official URL (E02-T01) | official URL | no | public data |
| `TOOBIT_API_KEY` | testnet/paper | testnet | testnet until gate | **yes** | trade-only, no withdraw |
| `TOOBIT_API_SECRET` | testnet/paper | testnet | testnet until gate | **yes** | rotation 90d (§12.5) |
| `SIGNAL_HMAC_SECRET` | dev value | staging value | prod value | **yes** | single-secret form for the signal webhook (E07-T01-S2b); never in repo |
| `SIGNAL_HMAC_SECRETS` | — | `{"<source>":"<secret>",…}` | per-source map | **yes** | keyed per source; overrides the single form when set |
| D1 database | `trading_dev` | `trading_stg` | `trading_prod` | binding | per-env in wrangler |
| Log level | `debug` | `info` | `warn` | no | JSON logs, trace evt IDs |

Related: [Secret store wiring](./SECRET-STORE.md) · [Security §07](../07-security-and-threat-model.md).
