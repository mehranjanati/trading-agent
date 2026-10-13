-- 0004_strategy_drafts.sql — AI strategy drafts (chat → Go code generation).
-- Drafts are REVIEW-ONLY: nothing executes until a human approves and
-- builds the artifact. The wasm column stays NULL until build; go-watcher
-- never reads drafts, only pinned registry rows.
CREATE TABLE IF NOT EXISTS strategy_drafts (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  prompt TEXT NOT NULL,
  code TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_strategy ON strategy_drafts(strategy_id, version);