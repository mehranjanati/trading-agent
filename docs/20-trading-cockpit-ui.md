# 20 — Trading Cockpit: single-surface UI consolidation (PROPOSED, E15)

**Status:** PROPOSED (design + plan only — no code in this doc) | **Owner:** dashboard | **Decision record:** [ADR-012](./decisions/ADR-012-trading-cockpit-single-surface.md)

Related: [09 dashboard & observability](./09-dashboard-and-observability.md) · [10 API contracts](./10-api-and-integration-contracts.md) · [19 bot runs](./19-bot-runs-single-multi-strategy.md) · [21 live readiness](./21-live-trading-readiness.md).

## 20.1 Problem

The dashboard grew to **17 URLs**: a root page, 15 route directories, and one
nested symbol room (`/setups/{symbol}`). Half of them render the same underlying rows:

- `/analysis` and `/analyze` are the same subject (advisory runs) with different framing (history vs. run form).
- `/watches` and `/zones` are the same rows, projected differently.
- `/signals`, `/events`, `/logs`, `/failover` are four timelines over `recovery_log` / `events`.
- `/approvals` and `/orders` are one flow (approval → intent → order → fill).
- `/setups` and `/setups/{symbol}` force a full page navigation to answer "what is
  happening on this symbol", while `/chat` is a second full page for the assistant.

Cost of the split: the trader has no single place where a symbol, its live price,
its armed zones, its last analysis, the assistant, and the pending approval are on
screen at once. The complexity is in the **navigation**, not in the data model —
every route already reads the same read-only BFF endpoints.

## 20.2 Target surface: 1 cockpit + 3 secondary views

| New view | Replaces | Content |
|---|---|---|
| `/cockpit` (primary, default) | `/`, `/setups`, `/setups/{symbol}`, `/watches`, `/zones`, `/chat`, `/analyze`, `/analysis` | symbol sidebar (venue list + live price) · watch board for the selected symbol (ACTIVE→… lifecycle) · inline advisory chat · inline analysis form + verdicts (with recent-run history) · Stalk card |
| `/execution` | `/approvals`, `/orders` | approvals queue with countdown, intents → orders → fills, positions (fills only), reconcile state |
| `/activity` | `/signals`, `/events`, `/logs`, `/failover` | one tabbed timeline: signals · events · errors/gaps · failover/drills/lease epochs |
| `/settings` | `/strategies`, `/strategy`, `/alerts` | strategy library + groups + drafts, risk-limit versions (read-only), Telegram topics |

`/` redirects to `/cockpit`. Legacy routes keep working (redirect + deep-link
preservation, §20.5) so a bookmark, a Telegram alert link, or an in-chat link never
404s.

## 20.3 Cockpit layout (normative sketch)

```
+----------------------+-----------------------------------------------------+
| symbol sidebar       | header: SYMBOL  price  [price badge]  [mode banner]  |
| filter: [ BTC    ]   +------------------------------------------------------+
| BTCUSDT  67,234 LIVE | watch board (this symbol, every status, ACTIVE first) |
| ETHUSDT   3,120 LIVE |   w_…  LONG  trigger>=67500  inval<=66800  ACTIVE     |
| SOLUSDT    182  —    |   w_…  SHORT trigger<=66800  inval>=67600  TRIGGERED  |
| … venue list …       +------------------------------------------------------+
| [open custom: …]     | analysis panel: direction / timeframes / strategies  |
|                      |   [Run analysis]  → aggregate bias + verdicts        |
+----------------------+------------------------------------------------------+
| inline assistant (chat) — advisory only, same session as /chat            |
|   user: analyze BTC 15m …                                                  |
|   assistant: bias LONG conf 0.72 … [Stalk this zone] [Save as draft]      |
+---------------------------------------------------------------------------+
```

Rules that the cockpit must keep (they are the reason the old split existed):

1. **One freshness badge per widget** (docs/09 §9.2) — merging routes must not merge badges.
2. **Mode banner always visible** (docs/09 §9.4) — lives in the layout, unchanged.
3. **Explicit UNAVAILABLE** — a failed read never renders as an empty table.
4. **Gap-explicit timelines** — `/activity` uses the same `timeline()` from `lib/freshness.mjs`.
5. **Execution venue notice** — the paper-sim banner in `+layout.svelte` stays.

## 20.4 Read-only is preserved (D-08)

Consolidation is a **navigation change**, not a permission change. In the cockpit:

- the assistant stays advisory (`/api/strategy:chat*`, Go chat service) — it can propose, never submit;
- the only write is `POST /api/watches` (Stalk — the human publish);
- `/analyze` remains `POST /analyze` against the Go plane (advisory), never an order path;
- approvals/orders stay **read-only** views: the dashboard has no approve/execute
  button and gains none in this slice (docs/02 §2.2, docs/08 §8.3).

Any proposal to add an "approve" button to the cockpit is a **separate ADR** with a
security review — it is explicitly out of scope here.

## 20.5 Route mapping & redirect table

| Legacy route | Behaviour after E15 | Deep links preserved |
|---|---|---|
| `/` | 302 → `/cockpit` | yes |
| `/setups` | 302 → `/cockpit` | yes |
| `/setups/{symbol}` | 302 → `/cockpit?symbol={symbol}` | yes — every Telegram/chat link keeps resolving |
| `/watches`, `/zones` | 302 → `/cockpit?symbol=…&tab=watches` | yes |
| `/chat` | 302 → `/cockpit?symbol=…&chat=1` (full-page chat kept as fallback) | yes |
| `/analyze`, `/analysis` | 302 → `/cockpit?symbol=…&tab=analysis` | yes |
| `/approvals`, `/orders` | 302 → `/execution` | yes |
| `/signals`, `/events`, `/logs`, `/failover` | 302 → `/activity?tab={…}` | yes |
| `/strategies`, `/strategy`, `/alerts` | 302 → `/settings?tab={…}` | yes |

The redirect is implemented in SvelteKit (`+page.ts` with `redirect(302, …)`), not
in the Worker: the BFF contract does not change.

## 20.6 Implementation slices (E15-T01)

| Slice | Output | Acceptance | Status |
|---|---|---|---|
| S1 shell | `/cockpit` route, symbol sidebar, selected-symbol store, layout badge/banner reuse | Given a direct visit When rendering Then sidebar + price + watch board paint from SSR data, no client-only blank | **DONE** (§20.9) |
| S2 panels | watch board + analysis panel + inline Stalk card moved into the cockpit | Given a symbol When selected Then its watches (all statuses) and analysis form render without navigation | **DONE** (§20.9) |
| S3 assistant | inline chat panel bound to the room session (`chat_session_{symbol}`) | Given a message When sent Then the same session as `/chat` continues; advisory banner visible | **DONE** (`RoomChat.svelte`) |
| S4 redirects | the §20.5 table wired, legacy pages removed | Given any legacy URL When opened Then 302 to the mapped cockpit URL and the target state is pre-selected | **DONE** — 16 redirects live; only `/chat` stays, by Q-18 (`/settings` absorbed `/strategies`, `/strategy`, `/alerts`) |

Each slice ships independently; the legacy pages are deleted only after the
redirect for that group is live in production.

## 20.7 Non-goals

- No new BFF endpoint is required. If a panel needs data the BFF does not serve, it
  renders UNAVAILABLE (docs/09 §9.4), not a fabricated value.
- No order/approval write path (see §20.4).
- No design-system rewrite: the existing `lib/components/ui/*` primitives are reused.
- No change to the freshness thresholds, badge vocabulary, or mode banner copy.

## 20.8 Acceptance criteria (E15 exit gate)

1. A trader can go from "I see BTCUSDT" to "a watch is armed" **without leaving `/cockpit`**.
2. Every legacy route in §20.5 redirects and preserves its state.
3. Badge coverage is unchanged: every data widget on the four views carries a badge
   that can show LIVE/STALE/CACHED/UNAVAILABLE.
4. `npm run check` (tsc + svelte-check) and `npm test` (node --test on
   `dashboard/src/lib/*.test.mjs`) stay green; new pure logic goes into
   `*-core.mjs` files so it stays unit-testable without a browser.
5. The paper-sim venue notice and the mode banner are visible on `/cockpit`.

## 20.9 Shipped (E15-T01 — S1, S2, S3 complete; S4 partial)

Built and verified in this increment:

| Piece | Where | Notes |
|---|---|---|
| Cockpit shell (S1) | `dashboard/src/routes/cockpit/+page.svelte` + `+page.ts` (`loadCockpit`) | SSR snapshot (health · symbols · watches · approvals · intents · positions · prices) in one parallel round trip, then a 15 s client refresh. The symbol comes from `?symbol=`, else the first non-IDLE room, else `BTCUSDT` |
| Symbol sidebar | same page | venue list + live price + derived room status (`deriveStatus`, the same function the room page uses) + `tradeable` vs `venue-only` (R-SYM preview) + armed count; filter + custom-symbol entry |
| Watch board (S2) | same page, `watchBoard()` | whole lifecycle, ACTIVE first; zones parsed by `parseZone`/`zoneText` (a malformed column renders "—", never a row of `?`) |
| Execution summary (S2) | same page, `approvalLines()` / `intentLines()` | approvals with derived state + live countdown, intents with `⚠ SUBMIT_UNKNOWN`, open position |
| Analysis panel + Stalk (S2) | same page | direction / timeframes / pinned-strategy picker / optional position / regime opt-in; aggregate = vote share, verdicts with `data_source`, ATR zones with the venue-source warning; `StalkSetup` is the only writer (`POST /api/watches`) |
| Inline assistant (S3) | `dashboard/src/lib/components/RoomChat.svelte` | bound to `chat_session_{symbol}` (same session as `/chat?symbol=`), WS with bounded reconnect → streamed REST fallback; advisory only. The floating global widget is hidden on `/cockpit` so only one assistant is on screen |
| Component strip | cockpit header | the old `/` overview's health table folded in, so redirecting `/` loses nothing |
| `/execution` (S4) | `routes/execution/*` | approvals queue + intents + positions, all read-only |
| `/activity` (S4) | `routes/activity/*` | one tabbed timeline (signals · events · errors · failover) using the SAME filters the old pages used; gaps stay explicit |
| Redirects (S4) | `$lib/legacy.ts` → `legacyRedirect()` | 302 for `/`, `/setups`, `/setups/{symbol}`, `/watches`, `/zones`, `/analyze`, `/analysis`, `/approvals`, `/orders`, `/signals`, `/events`, `/logs`, `/failover`, `/strategy` |
| Tests | `dashboard/src/lib/cockpit-core.test.mjs` | 13 tests: the redirect table row-by-row, zone parsing, watch ordering, approval state (fail closed), execution joins, board derivation, filters, aggregate, incident filters |

**Deliberately NOT redirected (and why):**

- `/chat` only — Q-18 keeps the full-page editor (charts, drafts, principles) until
  the inline panel has run for two weeks; the cockpit links to it. Everything else
  in the §20.5 table is redirected, including the last three: `/strategies` →
  `/settings?tab=groups`, `/strategy` → `/settings?tab=limits` and
  `/alerts` → `/settings?tab=alerts` (the settings page reads `?tab=`).

**Runtime evidence (node-adapter preview, HTTP status per route):**

```
/  /setups  /setups/BTCUSDT  /watches  /zones  /analyze  /analysis  /strategies
/strategy  /alerts                                                     → 302
/approvals  /orders  /signals  /events  /logs  /failover               → 302
/cockpit  /execution  /activity  /settings  /chat                      → 200
```

`npm run check` → 0 errors; `npm test` → 120 pass (13 new); `npm run build` → OK.
