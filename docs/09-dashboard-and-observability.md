# 09 — Dashboard & Observability (SvelteKit — decided Q-01)

## 9.1 Information architecture (routes)
| Route | Content | Freshness rule |
|---|---|---|
| `/` overview | mode banner, health cards (Go/Redis/Workers/D1/lease), key metrics | per-card badge |
| `/signals` | filterable signal feed (kind, symbol, source, time) | LIVE |
| `/watches` | ACTIVE watches + trigger/invalidation zones on mini-charts | LIVE, STALE if px old |
| `/zones` | price zones + invalidation lines per watch | CACHED ok + age |
| `/events` | entity timeline (`entity_id` search, evt links) | LIVE |
| `/analysis` | runs + confidence + rationale + model/version | CACHED + version |
| `/approvals` | pending queue with countdown, history | LIVE |
| `/orders` | intents→orders→fills + reconcile state | LIVE; UNKNOWN highlighted |
| `/failover` | incidents, drills, lease epochs, handoffs | LIVE |
| `/logs` | errors, latency p50/p95, data gaps | STALE tolerant |
| `/strategy` | config versions + diff + activator | versioned |

**Setup rooms keep the whole watch lifecycle.** `/setups/{symbol}` reads
`GET /api/watches` (every status, ACTIVE first) instead of the ACTIVE-only feed:
the watch FSM transitions a watch (ACTIVE→TRIGGERED→ANALYZED, or
ACTIVE→INVALIDATED|EXPIRED, docs/05 §5.3) and never deletes it, so a room built
on `status=ACTIVE` lost the watch, its approvals, its orders and its analysis
runs at the exact moment the zone triggered — the trade read as deleted while D1
still held every row. `/watches` itself stays ACTIVE-only (its row in the table
above is the live board); the room is where a trade's history stays readable.
The Stalk card also shows the trigger/invalidation distances from the close the
zone was measured on (`bandStats` in `lib/stalk.ts`): a band a fraction of a
percent wide is decided by the next tick, so the card says so before the click.

## 9.2 Freshness system
Badge component on every data widget: LIVE (<5s) green · STALE (≥threshold) amber · CACHED (fallback/last-known) grey · UNAVAILABLE red. Global mode banner always visible; order buttons disabled with reason tooltip when uncertain (SAFE-001).

## 9.3 Metrics, logs, alerts
- Metrics: `ws_uptime_s`, `tick_lag_ms`, `stream_lag_s`, `trigger_to_approval_p50/p95`, `reconcile_time_s`, `risk_rejects{by_code}`, `fallback_minutes`, `d1_error_rate`.
- Logs: JSON `{ts, level, component, trace_id(evt_id), msg, fields}`; trace = evt/intent ID end-to-end.
- Alerts (page operator): heartbeat loss, stale >30s, SUBMIT_UNKNOWN >5min, D1 errors >1%/5min, kill engaged/released, lease fencing flapping.

## 9.4 Degraded-mode UX (mandatory)
Persistent banner with mode + cause + limitations; timelines show explicit gaps (never interpolate); approve buttons show "blocked: STALE price (12s)" style reasons; one-click drill history.

## 9.5 Frontend decision (Q-01 closed)
SvelteKit + adapter-cloudflare, TypeScript strict, Tailwind optional. Rationale: smallest incident-time bundle, first-class Cloudflare support, simple SSR for SEO-irrelevant ops UI. Alternatives rejected: Next.js (heavier), plain Svelte SPA (weaker routing). Scaffold in E10-T01.

**Implemented (E10-T01):** all eleven routes exist with a per-widget badge; the freshness/badge/degraded-UX rules are pure functions in `dashboard/src/lib/freshness.mjs` with unit tests (LIVE/STALE/CACHED/UNAVAILABLE, mode banner with cause + limitations, verbatim action-block reasons, gap-explicit timelines). Each route uses a `+page.ts` `load` (SSR carries real data on first paint) plus an `onMount` refresh; `setInterval` never sits at component top level. The dashboard is read-only (GETs only — D-08). CI gained a dedicated `dashboard` job (`npm ci && npm run check && npm test && npm run build`); `make check` stays stdlib-only. `adapter-cloudflare`'s dev/preview path needs workerd (unavailable on macOS < 13.5), so a local render proof uses `DASH_ADAPTER=node` — never the deployed adapter. Views whose BFF read endpoints do not exist yet (`/signals`, `/analysis`, `/approvals`, `/orders`, `/strategy`) render UNAVAILABLE by design until the E12 wiring.
