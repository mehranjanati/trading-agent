-- 0010_regime_filter.sql — per-watch market-regime filter + v3-regime config version.
-- WHY: a user may want regime filtering (ETHBTC, USDT.D, BTC.D, TOTAL3 trend check)
-- on some watches but not others (e.g. a BTC scalp vs an alt swing). The flag lives
-- on the watch row so every position can opt in/out independently.
-- Forward-only: ALTER TABLE is additive; the new strategy_configs version is an
-- immutable audit row (newer version wins, see E07-T01 pinning).

ALTER TABLE watches ADD COLUMN regime_filter INTEGER NOT NULL DEFAULT 0;

-- v3-regime config is activated by the operator via POST /api/strategy:activate
-- with config_json containing the "regime" block. This migration only adds the
-- watch column; the config version stays operator-controlled (E07-T01 pinning).
