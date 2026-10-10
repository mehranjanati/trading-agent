# 04 — Data Model & Persistence (D1 canonical, Redis cache, DO coordination)

## D1 tables (proposed, owner: Workers)
- `watches(id TEXT PK, symbol, direction, trigger_json, invalidation_json, status, version, created_by, expires_at, created_at, updated_at)` idx(symbol,status).
- `watch_transitions(id, watch_id FK, from_s, to_s, reason, actor, at)` idx(watch_id,at).
- `signals(id PK, watch_id, kind, payload_json, source, at)` kinds: DIVERGENCE_TRIPLE|ORDER_BLOCK|OB_OS|MTF|REGIME.
- `events(id PK `evt_<ulid>`, type, entity_id, payload_json, dedupe_key UNIQUE, at)` — append-only log.
- `analysis_runs(id, watch_id, model, input_ref, output_json, confidence, at)`.
- `approvals(id, watch_id, analysis_id, decision, reason, approver, single_use, expires_at, at)`.
- `order_intents(id PK `intent_<ulid>`, watch_id, approval_id, side, qty, leverage, client_order_id UNIQUE, status, at)`.
- `orders(client_order_id PK, exchange_order_id, status, fills_json, last_reconciled_at)` statuses per §05.
- `positions(symbol PK, size, entry_px, leverage, updated_at)` snapshots from reconciled fills.
- `outbox(id, aggregate, payload_json, claimed_by, attempts, next_retry, done)` transactional outbox.
- `health_snapshots(id, component, status, detail_json, at)` + `recovery_log(id, incident, action, actor, at)`.
- `strategy_configs(version PK, config_json, activated_by, at)` versioned.

## Retention/migrations
- Ticks: never in D1. Events/audit: retain ≥2y (or per policy). Positions snapshots 1y. Migrations: versioned SQL in `migrations/`, forward-only, tested rollback plan.

## Redis structures — see §03. TTL px 30s; watch cache no TTL (explicit invalidate). Streams MAXLEN ~100k.

## DO storage
- `ExecutionAuthority`: `{holder, epoch, expires_at}`. Shards: `{cursor_stream_id, active_watch_ids}`. Fanout: ephemeral sockets only.

## Recovery data requirements
- Go+Redis restart reloads active Watches from `GET /api/watches/active-snapshot` (D1 truth). Redis loss ≠ business loss; replay Streams from last acked ID where configured.
