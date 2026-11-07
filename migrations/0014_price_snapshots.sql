-- 0014_price_snapshots.sql — last-known price per symbol (ADR-004).
--
-- WHY: GET /api/prices answered `prices: {}` on 2026-11-07 because the venue
-- returned HTTP 403 to the Worker's Cloudflare egress IP. A venue block must not
-- leave the desk with no number at all: the last price we actually saw is
-- honest data as long as it is LABELLED stale, and D1 is inside Cloudflare so no
-- third party can make it unreachable.
--
-- One row per symbol (the dashboard reads a single selected symbol at a time, so
-- a PRIMARY KEY on the symbol is the whole index). `at` is the observation time,
-- not the write time: the reader derives the age from it and the API reports it.
-- The table is a CACHE, never a source of truth — no order, approval or risk
-- decision may read it (D-08 unchanged).
CREATE TABLE IF NOT EXISTS price_snapshots(
  symbol TEXT PRIMARY KEY,
  px TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
