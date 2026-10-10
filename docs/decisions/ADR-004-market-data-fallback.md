# ADR-004 — Market-Data Fallback (rate-limited REST, adequacy must be proven)

Status: PROPOSED (math inputs VERIFY_REQUIRED) | Relates: §06, E02-T01, E06-T02

## Context
When the primary WS dies we still need bounded, honest quotes to supervise open watches — without violating Toobit rate limits or pretending tick parity.

## Decision
- Fallback = Workers/DO rate-limited REST polling of watched symbols only, via token bucket + jitter.
- Adequacy formula (must be computed in E02-T01 with official numbers): `min_poll_interval ≥ symbols × reqs_per_symbol_per_poll / rate_limit_per_sec × safety_factor(2)`.
- If the math fails for the desired symbol set: reduce symbols (priority order), increase interval with explicit staleness banners, or propose a secondary Go standby in a new ADR — never silently exceed limits.
- Dashboard must label fallback quotes CACHED/STALE and state the poll interval.

## Alternatives
- A: Claim REST tick parity — rejected unless demonstrated by test (no basis today).
- B: Secondary Go hot-standby now — deferred (cost/benefit decided in E06 with real metrics).
- C: No fallback quotes — rejected (leaves watches blind).

## Verification
E02-T01 records official limits (URL + date); E06-T02 load test proves poll cadence for N symbols without 429s.
