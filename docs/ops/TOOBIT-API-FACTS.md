# Toobit USDT-M Futures — Verified API Facts (E02-T01 evidence)

**Verified:** 2026-10-10 | **Source:** official docs `https://api-docs.toobit.com` (MIT-licensed pages fetched 2026-10-10) | **Status:** VERIFIED (closes A-01/A-02 inputs; Q-10 answered NO — no testnet found in docs)

## S1 — WebSocket market streams
- **Base URL:** `wss://stream.toobit.com`, path format `wss://#HOST/quote/ws/v1`.
- **Subscribe message:** `{"symbol": "$symbol0,$symbol1", "topic": "$topic", "event": "sub", "params": {"binary": false}}`. Unsubscribe: `"event": "cancel"`.
- **Topics (market):** `trade` (per-deal ticks, global incremental `v` tx-ID), `markPrice`, `kline_$interval`, `depth`, `diffDepth`, `bookTicker`, `wholeBookTicker`, `realtimes`.
- **Heartbeat:** client sends `{"ping": <ms>}`, server replies `{"pong": <ms>}`; **server disconnects within 5 minutes without ping**.
- **Symbol format on WS:** `BTC-SWAP-USDT` style (dash form), NOT `BTCUSDT` — normalizer must map `BTC-SWAP-USDT` ↔ `BTCUSDT`.
- **Tick example (trade):** `{"symbol":"BTC-SWAP-USDT","topic":"trade","data":[{"v":"1291465821801168896","t":1668690723096,"p":"399","q":"1","m":false}],"sendTime":...}` → fields: `v`=tx id, `t`=ms time, `p`=price, `q`=qty, `m`=buy?
- **Mark price:** `{"topic":"markPrice","data":[{"symbol":"BTC-SWAP-USDT","markPrice":"16792.28","time":...}]}`.
- **Design impact:** primary price source = `trade` last-`p` + `markPrice` for invalidation; bookTicker for spread sanity. WS disconnect budget: ping ≤4min.

## S2 — REST market + trading endpoints
- **Base URL:** `https://api.toobit.com`. Times in ms. Param order must match signature order for SIGNED endpoints.
- **Rate limits (official):** `REQUEST_WEIGHT` **3000/min**; `ORDERS` **60 per 2s**. 429 → error `-1003 TOO_MANY_REQUESTS` / `-1015 TOO_MANY_ORDERS`; back off until `X-Api-Limit-Reset-Timestamp`. Repeated 404/429 bursts may IP-ban — verify URLs before retrying.
- **Market (weight 1 each):** `GET /api/v1/time`, `GET /api/v1/exchangeInfo` (symbols, filters incl. `minNotional 10`, `exchangeInfo.rateLimits` **deprecated — do not rely**), `GET /quote/v1/contract/ticker/24hr`, `GET /quote/v1/contract/ticker/price` (latest `p` per `s`), `GET /quote/v1/contract/ticker/bookTicker`, `GET /quote/v1/index`.
- **`clientOrderId` SUPPORTED:** `POST /api/v1/futures/flashClose` documents `clientOrderId STRING NO — Client order ID (optional, auto-generated if not provided)`. → idempotency design (client ID = intent ID) is viable; E09-T01 must confirm the same field on the standard order-placement endpoint during testnet wiring.
- **Auth:** API key + signature; `timestamp` LONG mandatory, `recvWindow` LONG optional **default 5000, max 60000** (recommended ≤5000); reject if `timestamp` > server+1000ms or older than recvWindow.
- **Order statuses:** `PENDING_NEW, NEW, PARTIALLY_FILLED, FILLED, CANCELED, PENDING_CANCEL, REJECTED`. **5xx = UNKNOWN outcome** (may have succeeded) — exactly our SUBMIT_UNKNOWN case.
- **Futures sides:** v1 combined (`BUY_OPEN/SELL_OPEN/BUY_CLOSE/SELL_CLOSE`); v2 split (`side` BUY/SELL + `positionSide` LONG/SHORT). E09-T01 must pin v1 vs v2 at implementation.
- **Fallback math (ADR-004 inputs):** price-ticker poll = weight 1 → per-symbol 1 req; budget 3000/min = 50/s; safety ×2. E.g. 10 symbols × 1 req / 5s poll = 2/s ≪ 50/s ✓. Order budget untouched by polling (separate limiter).

## S3 — Q-03 + Q-10 answers
- **Q-03 (symbol universe):** deferred to trader — allowlist seed `BTCUSDT/ETHUSDT/SOLUSDT` (matches `exchangeInfo` spot example + futures `contracts[]`); fallback math holds to ~100 symbols at 5s poll.
- **Q-10 (testnet):** **NO testnet/paper URL found anywhere in official docs** (introduction, basic-info, market, trading pages searched 2026-10-10). → Decision: E09/E11 use a **Workers paper-simulator** (records intents, simulates fills) until a testnet is confirmed. Recorded in doc 14 as D-06.
- **IP restriction:** officially recommended on keys (introduction page) — matches our key policy.

## S2a — Live REST probe (2026-10-11) — price endpoint filter + shape

**Source:** live `https://api.toobit.com` from the dev machine (egress confirmed), read-only market data.

- `GET /api/v1/time` → 200 `{"serverTime":1791738585088}` — the REST plane is reachable and unauthenticated reads work.
- **`?symbol=<SYM>` (SINGULAR) is the working filter**: `GET /quote/v1/contract/ticker/price?symbol=BTCUSDT` → `[{"s":"BTCUSDT","p":"83999.27"}]` — one item, **canonical (dash-free) symbol form, no `si` field**. Verified for `BTCUSDT/ETHUSDT/SOLUSDT/DOGEUSDT/XRPUSDT`. ⚠ **S4 correction (2026-10-26):** that canonical answer is the **SPOT** book — the symbol form, not the path, selects the market. Futures requires `symbol=BTC-SWAP-USDT`; every REST market-data request now sends the venue form.
- **`?symbols=` (PLURAL) IS IGNORED**: with no param, `?symbols=BTCUSDT`, `?symbols=BTC-SWAP-USDT` and `?symbols=BTCUSDT,ETHUSDT` the endpoint answers the **whole venue** (~1033 markets / ~61KB on 2026-10-26), in the dash form + `si` → `{"s":"ZEN-SWAP-USDT","si":"ZEN-SWAP-USDT","p":"6.633"}`.
- 200 responses carried **no** `X-Api-Limit-*` headers (the reset header appears on 429, per S2).

**Design impact (implemented in `workers/src/fallback-poll.mjs`, E06-T02-S3c):**
1. Fallback polling issues **one filtered request per symbol** → weight 1 each, the ADR-004 math exactly as written (`symbols × 1/50 × 2` floor, 5s cadence).
2. Never request the batch form: it would return ~1000 unrelated markets on every round.
3. Any answer is **canonicalised and filtered against the poll set** before it can influence freshness; `BTC-SWAP-USDT` → `BTCUSDT` mirrors Go `normalize.ToCanonical` (dashes and the `SWAP` infix are removed), so both planes share one symbol identity. The REQUEST must go the other way — `normalize.ToVenue`/`venueSymbol` — because a canonical request answers the spot book (S4).
4. A round whose answer covers **none** of our symbols is recorded as `no-quotes` and never updates the snapshot age (no false freshness).

**Egress note:** the earlier "no egress" statement in `go-watcher/SOAK-NOTE.md` concerned the Go WS soak path; HTTPS REST from the dev machine works (probe above), so the S3c no-429 proof now includes a **live** observation (`docs/ops/drills/E06-T02/budget-live-*.json`). The 24h WS soak + the extended live window still attach to the E11 gate report.

## S4 — Symbol form selects the market (2026-10-26 correction to S2a)

**Source:** live `https://api.toobit.com`, read-only, same-second comparisons.

`/api/v1/exchangeInfo` carries TWO universes in one answer:
- `symbols` (536): **spot**, canonical `EDUUSDT` (fields `allowMargin`, `isAggregate`, `icebergAllowed`).
- `contracts` (783): **perpetuals**, dash form `BTC-SWAP-USDT` (773 USDT-margined + 10 USDC-margined, fields `inverse`, `index`, `marginToken`, `contractMultiplier`).

**The symbol form — not the URL path — selects the book:**

| Request | Same-moment price | Market |
|---|---|---|
| `/quote/v1/ticker/price?symbol=BTCUSDT` | 80312.09 | spot |
| `/quote/v1/contract/ticker/price?symbol=BTCUSDT` | 80312.09 | **spot** |
| `/quote/v1/contract/ticker/price?symbol=BTC-SWAP-USDT` | 80287.40 | USDT-M **futures** |
| `/quote/v1/klines?symbol=BTCUSDT` | vol 42.7 | spot candles |
| `/quote/v1/klines?symbol=BTC-SWAP-USDT` | vol 228 578 | **futures** candles |

Consequences (normative):
1. The repo form (`BTCUSDT`) is a symbol **identity**, never a Toobit futures selector. Every Toobit REST market-data request must send the venue form (`BTCUSDT → BTC-SWAP-USDT`): `normalize.ToVenue` in Go, `venueSymbol` in Workers.
2. A canonical-form answer on a futures path is the **spot echo** and must be refused — `toobitTicker` requires `s == ToVenue(symbol)`, and `parseQuotes(..., { venueForm: true })` drops rows without `-SWAP-`.
3. The bulk lists differ too: `/quote/v1/contract/ticker/price` = futures (1033 rows, dash form), `/quote/v1/ticker/price` = spot (1101 rows, canonical). `workers/src/symbols.mjs` reads the former, so its canonical list (`EDUUSDT`) denotes the **futures** contract.
4. **ETHBTC has no Toobit futures contract**: `ETHBTC` and `ETH-SWAP-BTC` both answer `400 -100010 Invalid Symbols`. The regime ETHBTC index is therefore computed from the **venue's own** `ETHUSDT`/`BTCUSDT` perpetual klines (requested in the `-SWAP-` form) as a bar-by-bar ETH/BTC ratio; OKX `ETH-BTC` → Binance `ETHBTC` → CoinGecko ratio are optional fallbacks only, and the run records `regime.detail.sources.ETHBTC = "toobit-futures-ratio"` when the venue answered.
5. Symbol coverage differs per universe: `CELRUSDT` answers `400 -100011 Not supported symbols` on the futures path (CELR exists only on spot). `prices`/`klines` fall through to the next provider for such symbols.
6. ADR-004 budget math is unchanged (one weight-1 request per symbol); only the query string changes.

**Impact:** S2a's "filtered form answers in the canonical form" was true but under-specified — that canonical answer was the **spot** book. The E02/E06 REST paths (`go-watcher/prices`, `workers/src/fallback-poll.mjs`) and the E14 klines path (`go-watcher/strategies/klines.go`) now request the venue form; regression tests pin the URL and the refusal of a spot echo.

Related: [ADR-004](../decisions/ADR-004-market-data-fallback.md) · [Contracts §10.4](../10-api-and-integration-contracts.md) · [Assumptions](../14-assumptions-decisions-and-open-questions.md).
