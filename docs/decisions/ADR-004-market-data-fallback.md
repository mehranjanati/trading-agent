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
- **The platform's OWN second egress is the real fix (2026-11-08).** The 403 above did not go away, and the D1 layer proved too narrow in practice — the picker listed **four** symbols (the allowlist plus `CELRUSDT`, seen in a watch) out of ~850 USDT-M markets, and `/api/prices` answered `prices: {}` with every symbol in `missing[]` because D1 had never observed one either. That is the state the operator reported: *"I search and nothing but these few coins comes up — and the price isn't there at all."* Meanwhile the SAME venue endpoints answered the Go plane on Render (`POST /analyze` → `data_source: "toobit-rest"` with a live last price). So the Worker keeps its venue-first read and, only when the venue refuses it, asks **its own plane**:
  - `go-watcher`: `GET /api/market/symbols` (venue catalog, canonical, `-SWAP-` only, ~850 rows) and `GET /api/market/prices?symbols=…` (≤25, reuses `prices.Fetch`, so the Redis-tick → Toobit-REST → Binance-REST pairing and "unknown is MISSING" are inherited);
  - `workers/src/market-bridge.mjs`: the handoff. `listSymbols` order is now cache → venue → **go-watcher** → stale cache → D1, and `listPrices` fills only the symbols the venue just refused, answering `source: "go-watcher"` + `bridged_symbols[]` (the venue keeps first say, and the ADR-004 weight window keeps counting what actually went there).
  - A bridged price is the **same venue's number, read seconds ago by our own plane**, so it is labelled live (`stale: false`) — not CACHED. It is still written to `price_snapshots` with `src = "go-watcher"`, so the D1 layer stays warm for a total blackout.
  - This is what alternative D should have said: not "add OKX/Binance as the Worker's symbol source", but "stop making the Worker's single egress the platform's only egress". No new third party, no widened universe (the bridged catalog passes the same `SYMBOL_RE` the venue path does).
- **A price widget fails closed (2026-11-08).** `GET /api/prices` answers 200 with `prices: {}` when nothing could be read, which is a perfectly FRESH response carrying no number — and the desk rendered it as a badge with a dash. The cockpit's price badge is therefore not a freshness badge: no number for the symbol → UNAVAILABLE, a D1 last-known row → CACHED (with its age), otherwise the response's own freshness (`dashboard/src/lib/cockpit-core.mjs` `priceBadge`, unit-tested). A degraded answer also carries `degraded: "<why>"`, which the desk prints under the header instead of leaving a silent dash.
- **Price the rows you draw (2026-11-08).** After the switch to a selected-symbol-only quote, every other sidebar row showed a dash even when the venue was healthy. The cockpit now asks for `MAX_PRICE_SYMBOLS` (25) targets at once — the selection first, then the visible rows — which is the same bounded cost the setups grid already paid.

## Alternatives
- A: Claim REST tick parity — rejected (5s poll ≠ ticks; bannered as degraded).
- B: Secondary Go hot-standby now — deferred (revisit if symbol count >100 or poll SLO missed in E06).
- C: No fallback quotes — rejected (leaves watches blind).
- D: Add OKX/Binance as the Worker's symbol source — rejected in favour of the cheaper and more honest option: the platform's OWN second egress (`go-watcher` `/api/market/symbols` + `/api/market/prices`, 2026-11-08). The D1 set did prove too narrow (four symbols), but trading one blocked third party for others whose cloud-IP policy is equally opaque buys nothing, while our own plane already reads the venue successfully and speaks the same symbol identity. Revisit only if the Go plane's egress is blocked too.


## Verification
E06-T02 load test proves 5s cadence for N symbols without 429s; alert if `X-Api-Limit-Reset-Timestamp` backoff ever triggers.

