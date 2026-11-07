# ADR-004 — Market-Data Fallback (rate-limited REST, adequacy PROVEN for ≤100 symbols)

Status: ACCEPTED (2026-10-10, inputs verified E02-T01) | Relates: §06, E02-T01, E06-T02

## Context
When the primary WS dies we still need bounded, honest quotes to supervise open watches — without violating Toobit rate limits or pretending tick parity.

## Verified inputs (E02-T01, source `https://api-docs.toobit.com`, accessed 2026-10-10)
- REST base `https://api.toobit.com`; `REQUEST_WEIGHT` **3000/min** (=50/s); `ORDERS` 60/2s (separate limiter, untouched by polling).
- Poll endpoint: `GET /quote/v1/contract/ticker/price` weight **1** (per-symbol or all-symbols array). **Symbol form selects the market** (S4, 2026-10-26): request `BTC-SWAP-USDT`; `BTCUSDT` answers the spot book even on this path.
- WS base `wss://stream.toobit.com` + `/quote/ws/v1`; topics `trade/markPrice/bookTicker/...`; ping required or disconnect ≤5min; WS symbol form `BTC-SWAP-USDT`.

## Decision
- Fallback = Workers/DO rate-limited REST polling of watched symbols only, via token bucket + jitter.
- Adequacy math (proven): `min_poll_interval ≥ symbols × 1 / 50 × 2`. 10 symbols → 0.4s floor → chosen **5s poll** (12× margin). 100 symbols → 4s floor → 5s poll still holds. Beyond 100 symbols: reduce set or slow poll with banners.
- Dashboard labels fallback quotes CACHED/STALE and states the poll interval.
- **Quote ONE symbol, not the market list (2026-11-08).** Every dashboard surface used to call `GET /api/prices` with no `symbols` parameter, which answers the WHOLE venue from one unfiltered request — ~1000 markets / ~61KB, every 15s, to paint a single header number. The cockpit now asks for the selected symbol only (and refetches immediately when the selection changes instead of waiting for the tick), the setups grid asks for the rooms it is about to render (bounded by `MAX_FILTERED = 25`), and the SSR preload no longer fetches prices at all because the selection is derived client-side from that very response.
- **A venue block never blanks the number (2026-11-07/08).** When the venue refused the Worker (HTTP 403 to Cloudflare egress), `GET /api/prices` returned `prices: {}` and every symbol "missing". The last price we actually observed is honest data as long as it is labelled: `price_snapshots(symbol PRIMARY KEY, px, src, at)` (migration 0014) is written at most once a minute per symbol on a successful read, and on a failed read it answers with `stale: true`, `stale_symbols: [<which>]`, `source: "d1"`. A symbol we have NEVER seen stays in `missing[]` — the fallback can never invent a price. The table is a cache: no order, approval or risk decision reads it (D-08 unchanged).
- **A single venue is a single point of failure for the CATALOG too (2026-11-07).** The venue answered `HTTP 403` to the Worker's Cloudflare egress IP while the same URL returned 200 from a laptop, which blanked `GET /api/symbols` with a 503 and left the dashboard's symbol picker unusable — even though the platform already knew which symbols it trades. So the symbol list is fail-soft in three layers, in this order: (1) `SYMBOLS_KV` cache, (2) in-isolate memory, (3) **D1** — the ACTIVE `strategy_configs` allowlist plus every symbol already seen in `watches`/`positions`. Layer 3 answers the dashboard with `stale: true`, `source: "d1"` and `degraded: "<venue error>"`, so the picker stays usable and the reason is explicit. It never throws: a total miss is still a 200-shaped answer carrying `degraded`. The same doctrine already governs klines (`toobit-rest → okx-rest → binance-rest` in `go-watcher/strategies/klines.go`).

## Alternatives
- A: Claim REST tick parity — rejected (5s poll ≠ ticks; bannered as degraded).
- B: Secondary Go hot-standby now — deferred (revisit if symbol count >100 or poll SLO missed in E06).
- C: No fallback quotes — rejected (leaves watches blind).
- D: Add OKX/Binance as the Worker's symbol source — deferred: it trades one blocked third party for others whose cloud-IP policy is equally opaque; D1 cannot be blocked by anyone and is already the platform's own record. Revisit if the D1 set proves too narrow in practice.


## Verification
E06-T02 load test proves 5s cadence for N symbols without 429s; alert if `X-Api-Limit-Reset-Timestamp` backoff ever triggers.

