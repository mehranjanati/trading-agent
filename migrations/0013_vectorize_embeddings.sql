-- 0013_vectorize_embeddings.sql — mapping table for RAG semantic search (Vectorize).
--
-- WHY: FTS5 BM25 (migrations/0012) handles keyword search well but misses
-- semantic similarity (e.g. "position sizing" vs "how much to risk per trade").
-- This table stores the mapping from each rag_docs chunk to its Vectorize
-- vector id, so the Worker can query semantic neighbors via the VECTORIZE
-- binding and merge results with BM25 (hybrid retrieval).
--
-- Ingestion is OFFLINE (scripts/ingest-vectorize.mjs): it calls Workers AI
-- embedding model, upserts vectors to Vectorize, and writes this mapping.
-- Chat only READS this table (and calls Vectorize.query) — D-08 unchanged.
-- Forward-only migration.

CREATE TABLE IF NOT EXISTS rag_doc_vectors (
  id            TEXT PRIMARY KEY,   -- same as rag_docs.id (e.g. docs/08-trading-risk.md#0)
  vector_id     TEXT NOT NULL,      -- Vectorize point id (same as id for simplicity)
  chunk_idx     INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,      -- sha256 of chunk text; skip re-ingest if unchanged
  updated_at    TEXT NOT NULL
);

-- Index for re-ingest diff detection (only chunks whose hash changed need upsert).
CREATE INDEX IF NOT EXISTS idx_rag_doc_vectors_hash ON rag_doc_vectors(content_hash);

-- Rollback plan: forward-fix only. Dropping this table disables semantic search
-- but falls back to FTS5 keyword search — never fabricates an order (D-08).
