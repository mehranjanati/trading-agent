# ADR-004 — Market-Data Fallback (rate-limited REST, adequacy PROVEN for ≤100 symbols)

Status: ACCEPTED (2026-10-10, inputs verified E02-T01) | Relates: §06, E02-T01, E06-T02

## Context
When the primary WS dies we still need bounded, honest quotes to supervise open watches — without violating Toobit rate limits or pretending tick parity.

## Verified inputs (E02-T01, source `https://api-docs.toobit.com`, accessed 2026-10-10)
- REST base `https://api.toobit.com`; `REQUEST_WEIGHT` **3000/min** (=50/s); `ORDERS` 60/2s (separate limiter, untouched by polling).
- Poll endpoint: `GET /quote/v1/contract/ticker/price` weight **1** (per-symbol or all-symbols array).
- WS base `wss://stream.toobit.com` + `/quote/ws/v1`; topics `trade/markPrice/bookTicker/...`; ping required or disconnect ≤5min; WS symbol form `BTC-SWAP-USDT`.

## Decision
- Fallback = Workers/DO rate-limited REST polling of watched symbols only, via token bucket + jitter.
- Adequacy math (proven): `min_poll_interval ≥ symbols × 1 / 50 × 2`. 10 symbols → 0.4s floor → chosen **5s poll** (12× margin). 100 symbols → 4s floor → 5s poll still holds. Beyond 100 symbols: reduce set or slow poll with banners.
- Dashboard labels fallback quotes CACHED/STALE and states the poll interval.

## Alternatives
- A: Claim REST tick parity — rejected (5s poll ≠ ticks; bannered as degraded).
- B: Secondary Go hot-standby now — deferred (revisit if symbol count >100 or poll SLO missed in E06).
- C: No fallback quotes — rejected (leaves watches blind).

## Verification
E06-T02 load test proves 5s cadence for N symbols without 429s; alert if `X-Api-Limit-Reset-Timestamp` backoff ever triggers.

