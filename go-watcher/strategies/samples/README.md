// strategies/samples — registry for the Phase-1 sample strategies.
//
// registry.json pins id@version to artifact files; configuration is the
// strategy_configuration baseline the AI/chat may override per call via the
// analyze request's per-strategy config overlay.
//
// name/description are OPTIONAL catalog labels served by
// GET /strategies/registry (registry_endpoint.go) and rendered by the
// dashboard library tab — this file is the only place they live.
