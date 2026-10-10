-- 0002_schema.sql — E04-T01-S1: canonical D1 schema (forward-only, never edit after apply).
-- Source: docs/04-data-model-and-persistence.md §4.1. Ticks are NEVER stored in D1.
CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL,
 trigger_json TEXT NOT NULL, invalidation_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_watches_sym_status ON watches(symbol,status);
CREATE TABLE IF NOT EXISTS watch_transitions(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES watches(id),
 from_s TEXT, to_s TEXT NOT NULL, reason TEXT, actor TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_trans_watch_at ON watch_transitions(watch_id,at);
CREATE TABLE IF NOT EXISTS signals(id TEXT PRIMARY KEY, watch_id TEXT REFERENCES watches(id), kind TEXT NOT NULL,
 payload_json TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_signals_watch ON signals(watch_id,at);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_id TEXT NOT NULL,
 payload_json TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id,at);
CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type,at);
CREATE TABLE IF NOT EXISTS analysis_runs(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES watches(id),
 model TEXT NOT NULL, input_hash TEXT NOT NULL, output_json TEXT NOT NULL, confidence REAL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, analysis_id TEXT NOT NULL,
 decision TEXT NOT NULL, reason TEXT, approver TEXT NOT NULL, single_use INTEGER DEFAULT 1,
 used_at TEXT, expires_at TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_approvals_watch ON approvals(watch_id,at);
CREATE TABLE IF NOT EXISTS order_intents(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, approval_id TEXT NOT NULL,
 side TEXT NOT NULL, qty TEXT NOT NULL, leverage INTEGER NOT NULL, client_order_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'INTENT', at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_intents_status ON order_intents(status,at);
CREATE TABLE IF NOT EXISTS orders(client_order_id TEXT PRIMARY KEY, exchange_order_id TEXT, status TEXT NOT NULL,
 fills_json TEXT DEFAULT '[]', last_reconciled_at TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positions(symbol TEXT PRIMARY KEY, size TEXT NOT NULL, entry_px TEXT, leverage INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, aggregate TEXT NOT NULL, payload_json TEXT NOT NULL,
 claimed_by TEXT, attempts INTEGER DEFAULT 0, next_retry TEXT, done INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(done,next_retry);
CREATE TABLE IF NOT EXISTS health_snapshots(id TEXT PRIMARY KEY, component TEXT NOT NULL, status TEXT NOT NULL, detail_json TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_health_comp_at ON health_snapshots(component,at);
CREATE TABLE IF NOT EXISTS recovery_log(id TEXT PRIMARY KEY, incident TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS strategy_configs(version TEXT PRIMARY KEY, config_json TEXT NOT NULL, activated_by TEXT NOT NULL, at TEXT NOT NULL);
-- Rollback plan: forward-fix only (0003_...). Load-bearing constraints (dedupe_key, client_order_id) must never be dropped.
