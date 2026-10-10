-- 0001_init placeholder. Full D1 schema lands in E04-T01 per docs/04-data-model-and-persistence.md.
-- Forward-only. Never edit applied migrations; add 0002_... instead.
CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
