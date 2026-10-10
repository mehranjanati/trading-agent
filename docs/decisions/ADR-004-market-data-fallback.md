# ADR-004 — Market-Data Fallback

Status: PROPOSED | Date: 2026-10-10

## Context
Primary WS may die; need bounded degraded quotes.

## Decision
Rate-limited REST polling from Workers/DO as fallback only. Adequacy NOT claimed until math done: `poll_interval >= symbols*requests_per_symbol / rate_limit * safety(2x)`. If math fails → reduce symbols or add secondary Go (optional) — decided in E06.

## Alternatives
A: Continuous tick parity via REST — rejected unless proven. B: Secondary Go hot-standby — deferred, cost/benefit in E06. C: No fallback quotes — rejected (blind).

## Verification
Load test with N symbols; record Toobit limits URL+date (VERIFY_REQUIRED).
