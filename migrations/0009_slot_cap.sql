-- 0009_slot_cap.sql — E09-T01c: activate the portfolio slot cap (docs/19 §19.7 gap 1).
-- WHY A NEW VERSION: `strategy_configs` rows are immutable audit records and the
-- ACTIVE version is the newest row by `at` (E07-T01 pinning). The slot caps are
-- therefore activated as a NEW version (v2-paper) rather than by editing v1-paper,
-- so every order verdict still echoes the exact limits version that judged it.
--
-- R-SLOT bounds: max_active_watches (concurrent ACTIVE watches, portfolio-wide)
-- and max_active_watches_per_symbol (same, per symbol). Both are OPTIONAL in
-- the config: absent = no cap (the gate is skipped), present = the cap applies
-- and an UNKNOWN count fails closed (SAFE-001).
INSERT INTO strategy_configs(version, config_json, activated_by, at) VALUES (
 'v2-paper',
 '{"max_leverage":5,"max_notional_usd":"1000","max_exposure_usd":"5000","allowlist":["BTCUSDT","ETHUSDT","SOLUSDT"],"stale_s_seconds":5,"approval_ttl_s":600,"min_confidence":0.55,"fallback_orders_enabled":false,"max_active_watches":10,"max_active_watches_per_symbol":3}',
 'system-seed',
 datetime('now')
) ON CONFLICT(version) DO NOTHING;
