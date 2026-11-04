-- 0011_chat_persistence.sql — durable chat transcripts in D1.
--
-- WHY: chat text lived ONLY in Redis (`chat:{id}:msgs`, 24h TTL), so a
-- conversation vanished after a day (or a Redis restart), and the session id
-- lived only in the browser's localStorage. `chat_attachments` (0005) already
-- keeps chart METADATA with the bytes in R2 — but the message text itself was
-- never durable. This migration makes D1 the canonical log; Redis stays a
-- cache, R2 keeps the image bytes (ADR-010, ADR-014).
--
-- SESSION KEY: one permanent thread per symbol, id = "sym_<SYMBOL>"
-- (e.g. sym_OPENUSDT), minted by the chat service. The legacy floating widget
-- keeps its random `chat_<ts>_<rand>` id. `symbol` is '' for that legacy case;
-- the partial UNIQUE index therefore cannot collide on it.
CREATE TABLE IF NOT EXISTS chat_sessions(
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL DEFAULT '',
  principles TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_symbol ON chat_sessions(symbol) WHERE symbol <> '';

CREATE TABLE IF NOT EXISTS chat_messages(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- attachment METADATA only ([{mediaType,detail,bytes}]): the bytes live in R2
  -- (chat_attachments.r2_key), because D1 caps a row at 2,000,000 bytes.
  attachments_json TEXT NOT NULL DEFAULT '[]',
  message_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_session ON chat_messages(session_id, at);
-- Rollback plan: forward-fix only (0012_...). Chat is advisory data; dropping
-- these tables would lose transcripts but could never fabricate an order.
