-- 0003_seed.sql — E04-T01-S3: default strategy config (paper-safe limits per doc 08.2).
INSERT INTO strategy_configs(version, config_json, activated_by, at) VALUES (
 'v1-paper',
 '{"max_leverage":5,"max_notional_usd":"1000","max_exposure_usd":"5000","allowlist":["BTCUSDT","ETHUSDT","SOLUSDT"],"stale_s_seconds":5,"approval_ttl_s":600,"min_confidence":0.55,"fallback_orders_enabled":false}',
 'system-seed', datetime('now')
) ON CONFLICT(version) DO NOTHING;
