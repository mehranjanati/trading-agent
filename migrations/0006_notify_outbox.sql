-- 0006_notify_outbox.sql — Telegram alerting outbox + per-topic user prefs.
--
-- WHY A SEPARATE OUTBOX: the trading path never calls Telegram synchronously
-- (a push outage must not slow or fail a trigger/approval/order). Routes only
-- ENQUEUE rows here; the Workers cron drains them via notify.mjs. Retries
-- never double-send: dedupe_key is UNIQUE (one alert per event edge).
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  symbol TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_due ON notification_outbox(sent_at, attempts, at);

-- Per-topic user preference (5m/15m scalping: the user picks which topics
-- push to Telegram). Absent row = enabled (notify.mjs topicEnabled default).
CREATE TABLE IF NOT EXISTS notify_prefs (
  topic TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
