# 04 — Data Model & Persistence (D1 canonical · Redis cache · DO coordination)

## 4.1 D1 DDL (E04-T01 implements; forward-only migrations)
```sql
CREATE TABLE watches(id TEXT PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL,
 trigger_json TEXT NOT NULL, invalidation_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_watches_sym_status ON watches(symbol,status);
-- 0010_regime_filter.sql (forward-only ALTER): per-watch opt-in for the
-- pre-analysis market-regime veto (docs/08 §8.2a). 1 = the Worker evaluates
-- ETHBTC/USDT.D/BTC.D/TOTAL3 before analysis; 0 = no regime gate for this watch.
-- ALTER TABLE watches ADD COLUMN regime_filter INTEGER NOT NULL DEFAULT 0;
CREATE TABLE watch_transitions(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES watches(id),
 from_s TEXT, to_s TEXT NOT NULL, reason TEXT, actor TEXT, at TEXT NOT NULL);
CREATE INDEX idx_trans_watch_at ON watch_transitions(watch_id,at);
CREATE TABLE signals(id TEXT PRIMARY KEY, watch_id TEXT REFERENCES watches(id), kind TEXT NOT NULL,
 payload_json TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE events(id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_id TEXT NOT NULL,
 payload_json TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, at TEXT NOT NULL);
CREATE INDEX idx_events_entity ON events(entity_id,at);
CREATE TABLE analysis_runs(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES watches(id),
 model TEXT NOT NULL, input_hash TEXT NOT NULL, output_json TEXT NOT NULL, confidence REAL, at TEXT NOT NULL);
CREATE TABLE approvals(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, analysis_id TEXT NOT NULL,
 decision TEXT NOT NULL, reason TEXT, approver TEXT NOT NULL, single_use INTEGER DEFAULT 1,
 used_at TEXT, expires_at TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE order_intents(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, approval_id TEXT NOT NULL,
 side TEXT NOT NULL, qty TEXT NOT NULL, leverage INTEGER NOT NULL, client_order_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'INTENT', at TEXT NOT NULL);
CREATE TABLE orders(client_order_id TEXT PRIMARY KEY, exchange_order_id TEXT, status TEXT NOT NULL,
 fills_json TEXT DEFAULT '[]', last_reconciled_at TEXT, at TEXT NOT NULL);
CREATE TABLE positions(symbol TEXT PRIMARY KEY, size TEXT NOT NULL, entry_px TEXT, leverage INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE outbox(id TEXT PRIMARY KEY, aggregate TEXT NOT NULL, payload_json TEXT NOT NULL,
 claimed_by TEXT, attempts INTEGER DEFAULT 0, next_retry TEXT, done INTEGER DEFAULT 0);
CREATE TABLE health_snapshots(id TEXT PRIMARY KEY, component TEXT NOT NULL, status TEXT NOT NULL, detail_json TEXT, at TEXT NOT NULL);
CREATE TABLE recovery_log(id TEXT PRIMARY KEY, incident TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE strategy_configs(version TEXT PRIMARY KEY, config_json TEXT NOT NULL, activated_by TEXT NOT NULL, at TEXT NOT NULL);
```
Key relationships: watches 1—N transitions/signals/runs/intents; approvals 1—1 intents (single-use enforced by `used_at`); intents 1—1 orders by `client_order_id`.

**Versioned payloads (E07-T01):** no schema change was needed — version stamps live inside existing columns. A `signals.payload_json` carries `_schema_version` (the registry contract that admitted it), and an `analysis_runs.output_json` carries `strategy_version` (the active `strategy_configs` version pinned at run start). Both are additive keys, so forward-only migrations stay untouched and old rows keep their original pin.

## 4.2 Retention & migrations
- Ticks: never in D1. Events/audit ≥2y; positions snapshots 1y; health 90d. Migrations `migrations/NNNN_*.sql`, forward-only, `wrangler d1 migrations apply` per env; failed migration → forward fix, never edit applied files.

## 4.3 Redis structures (operational, recoverable)
`px:{sym}` HASH TTL30s · `watch:active:{id}` HASH · Streams `events:*` MAXLEN 100k · `cg-workers` group · `hb:go:{id}` 15s TTL. Cold start: `GET /api/watches/active-snapshot` → repopulate → resume from last ack.

## 4.4 DO storage
`ExecutionAuthority`: `{holder, epoch, expires_at}` only. Shards: `{cursor, active_ids[]}`. Fanout: none durable. DO is coordination, not truth — D1 remains canonical.

## 4.5 Recovery data requirements (checklist)
R-01 ACTIVE watches reloadable from D1. R-02 Stream resume from last ack. R-03 All non-terminal intents reconcilable by `client_order_id`. R-04 Lease re-acquirable with bumped epoch. R-05 Dashboard serves last-known + badges without D1 writes.
