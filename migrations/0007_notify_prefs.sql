-- 0007_notify_prefs.sql — Telegram alert topics preferences (docs/09 §9.3a).
-- Advisory-only: toggles which events push to Telegram, never triggers an order/approval.
-- RBAC: trader+ may toggle (browser POST allow-list). 400 on unknown topic.
-- Schema: store one row per topic; absent rows = enabled.

CREATE TABLE IF NOT EXISTS notify_prefs (
  topic TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (topic)
);

-- Seed all seven topics enabled.  The user then toggles via /api/notify:prefs.
-- Topic order mirrors workers/src/notify.mjs TOPICS array.
-- SAFETY is intentionally first: never mute.
INSERT INTO notify_prefs (topic, enabled, updated_at)
VALUES
  ('SAFETY', TRUE, CURRENT_TIMESTAMP),
  ('TRIGGERED', TRUE, CURRENT_TIMESTAMP),
  ('INVALIDATED', TRUE, CURRENT_TIMESTAMP),
  ('ANALYSIS_READY', TRUE, CURRENT_TIMESTAMP),
  ('APPROVAL_REQUESTED', TRUE, CURRENT_TIMESTAMP),
  ('ORDER_UPDATE', TRUE, CURRENT_TIMESTAMP),
  ('POSITION_DIGEST', TRUE, CURRENT_TIMESTAMP)
ON CONFLICT (topic) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  updated_at = EXCLUDED.updated_at;
