-- 0005_chat_attachments.sql — chart screenshots attached to chat turns.
--
-- WHY R2 AND NOT THIS TABLE: D1 caps a single string/BLOB/row at 2,000,000
-- bytes, so a base64 chart image can never live in a column here. The BYTES go
-- to the R2 bucket (binding CHAT_MEDIA, key = r2_key); this table holds only
-- the metadata needed to answer "which chart produced this code?" (ADR-010).
--
-- id is the attachment id; message_id is the WS `messageId` the client
-- generated (crypto.randomUUID) and Go echoed back on the `done` event, so a
-- saved strategy draft can be traced to the exact chart it came from.
CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_attach_msg ON chat_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_attach_session ON chat_attachments(session_id, created_at);

-- Provenance: a draft generated from a chart turn records the turn id, so
-- "which chart produced this code?" is a join, not a guess. NULL for drafts
-- generated from text alone (the /api/strategy:generate path).
ALTER TABLE strategy_drafts ADD COLUMN message_id TEXT;
