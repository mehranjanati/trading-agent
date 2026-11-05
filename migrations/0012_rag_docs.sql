-- 0012_rag_docs.sql — lightweight RAG corpus for the advisory chat plane.
--
-- WHY: the model has no platform/docs access of its own. Every turn already
-- carries a PLATFORM SNAPSHOT (live state) and ROOM context; this adds a
-- RETRIEVED KNOWLEDGE block (top-k chunks from docs/ + ADRs + ops notes) so
-- the model can answer from the project's own risk/contract/venue facts
-- instead of guessing or hallucinating.
--
-- FTS5 external-content table keeps the canonical text in `rag_docs` and the
-- full-text index in `rag_docs_fts`. BM25 ranking via `bm25(rag_docs_fts)`.
-- Ingestion is offline (scripts/ingest-docs.mjs) — chat only READS, so D-08
-- and advisory-only are unchanged. Forward-only; no destructive down-path.

CREATE TABLE IF NOT EXISTS rag_docs (
  id           TEXT PRIMARY KEY,        -- e.g. docs/08-trading-risk.md#section-3
  path         TEXT NOT NULL,           -- source file path
  title        TEXT NOT NULL,           -- human title (file name or heading)
  section      TEXT,                    -- nearest ## heading
  content      TEXT NOT NULL,           -- chunk text (<= ~800 chars)
  chunk_idx    INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,           -- sha256 of content; skip re-ingest if unchanged
  updated_at   TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS rag_docs_fts USING fts5(
  title, section, content,
  content='rag_docs', content_rowid='id'
);

-- Keep FTS in sync with the canonical table (ingestion script also writes
-- directly, but triggers protect against any other writer).
CREATE TRIGGER IF NOT EXISTS rag_docs_ai AFTER INSERT ON rag_docs BEGIN
  INSERT INTO rag_docs_fts(rowid, title, section, content)
  VALUES (new.id, new.title, new.section, new.content);
END;
CREATE TRIGGER IF NOT EXISTS rag_docs_ad AFTER DELETE ON rag_docs BEGIN
  INSERT INTO rag_docs_fts(rag_docs_fts, rowid, title, section, content)
  VALUES ('delete', old.id, old.title, old.section, old.content);
END;
CREATE TRIGGER IF NOT EXISTS rag_docs_au AFTER UPDATE ON rag_docs BEGIN
  INSERT INTO rag_docs_fts(rag_docs_fts, rowid, title, section, content)
  VALUES ('delete', old.id, old.title, old.section, old.content);
  INSERT INTO rag_docs_fts(rowid, title, section, content)
  VALUES (new.id, new.title, new.section, new.content);
END;

-- Rollback plan: forward-fix only. Dropping these tables loses the RAG corpus
-- but can never fabricate an order or touch advisory state (D-08).
