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
| `LIVE_TRADING_ENABLED` | *(absent)* | *(absent)* | *(absent)* | no | **fail-closed live gate — must stay absent until the docs/21 §21.9 gate is signed** (ADR-013, docs/13 §13.8). `true` selects the signed adapter only when `ENV=live` |
| `TOOBIT_RECV_WINDOW` | — | — | — | no | live only; signed-request clock-skew guard (default 5000 ms), caller must be NTP-synced |
| `POSITION_MODE` | — | — | — | no | live only; `one-way` \| `hedge`, must match the account and is verified at boot (Q-15) |
| `MARGIN_TYPE` | — | — | — | no | live only; `cross` \| `isolated`, verified at boot (Q-15) |
| `SIGNAL_HMAC_SECRET` | dev value | staging value | prod value | **yes** | single-secret form for the signal webhook (E07-T01-S2b); never in repo |
| `SIGNAL_HMAC_SECRETS` | — | `{"<source>":"<secret>",…}` | per-source map | **yes** | keyed per source; overrides the single form when set |
| `GO_AGENT_TOKEN` | `dev-token` | staging value | prod value | **yes** | shared secret the Go plane sends as `x-agent-token` on service routes (heartbeat, `POST /api/watches:trigger`); falls back to `GO_HEARTBEAT_TOKEN` when unset |
| `GO_WATCHER_URL` | `http://127.0.0.1:8090` | watcher origin | watcher origin | no | the Worker's origin for the Go plane (advisory proxy + analysis runs + trigger edges); baked-in Render default |
| `TRIGGER_FEED` | `rest` | `ws` | `ws` | no | Go tick source: `rest` = ADR-004 price poll, `ws` = production socket feed (+ Redis `px:{sym}` publish) |
| `TOOBIT_BASE` | `https://api.toobit.com` | same | same | no | venue REST base (drills can point it at a local stand-in) |
| D1 database | `trading_dev` | `trading_stg` | `trading_prod` | binding | per-env in wrangler |
| R2 bucket (`CHAT_MEDIA`) | `trading-chat-media` | per-env | per-env | binding | chart bytes for chat turns (ADR-010); D1 keeps metadata only |
| `AI_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | same | same | no | text-only chat turns |
| `AI_VISION_MODEL` | `@cf/qwen/qwen3.8-27b` | same | same | no | chart turns (ADR-010); ~1432 prompt tokens per 1600x900 chart at `detail:"low"` |
| `AI_EMBEDDING_MODEL` | `@cf/baai/bge-m3` | same | same | no | query/chunk embeddings for RAG semantic search; 1024-dim (must match the Vectorize index) |
| Vectorize index (`VECTORIZE`) | *(binding commented)* | per-env | per-env | binding | RAG semantic retrieval over `docs/` (migrations/0013 + `scripts/ingest-vectorize.mjs`). Opt-in: run `make vectorize-index`, then uncomment `[[vectorize]]` in both wrangler configs — a binding to a missing index fails the deploy closed (code 10159). FTS5 BM25 (0012) is the keyword fallback meanwhile |
| Log level | `debug` | `info` | `warn` | no | JSON logs, trace evt IDs |

Related: [Secret store wiring](./SECRET-STORE.md) · [Security §07](../07-security-and-threat-model.md).
