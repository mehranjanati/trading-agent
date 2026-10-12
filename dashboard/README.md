# Dashboard — SvelteKit (Q-01 decided 2026-10-10; scaffolded E10-T01)

Read-only ops UI over the Workers BFF. **It never submits an order or an
approval** (docs/02 §2.2, D-08): `src/lib/api.ts` exposes GETs only, and the
order path lives in Workers.

## Run

```bash
npm ci
npm run check   # svelte-check, TypeScript strict
npm test        # freshness / badge / degraded-UX unit tests (node:test, no browser)
npm run build   # production build — adapter-cloudflare (Pages/Workers)
```

### Local render proof without workerd

`adapter-cloudflare`'s dev/preview path starts **workerd**, which cannot run on
macOS < 13.5 (`Unsupported macOS version` — the same limitation already recorded
for `wrangler dev` in `docs/ops/DRILLS.md`). For a local render check only:

```bash
DASH_ADAPTER=node npm run build && node build/index.js   # serves on :3000
```

The node adapter is a **local proof affordance**; the default (and the only
adapter that deploys) is adapter-cloudflare.

## Routes (docs/09 §9.1)

`/` overview · `/signals` · `/watches` · `/zones` · `/events` · `/analysis` ·
`/approvals` · `/orders` · `/failover` · `/logs` · `/strategy` — eleven routes,
each with its own freshness badge.

## Freshness & degraded UX (docs/09 §9.2/§9.4) — `src/lib/freshness.mjs`

- **LIVE** (<5s, green) · **STALE** (≥threshold, amber) · **CACHED**
  (fallback/last-known, grey) · **UNAVAILABLE** (red). An **unknown age is never
  LIVE** — it fails closed to UNAVAILABLE.
- A successful call's `at` drives the badge; a failed call renders
  `UNAVAILABLE — <error>`, never an empty table that looks like "no data".
- The mode banner is visible whenever mode ≠ PRIMARY, with the cause and the
  concrete limitations of that mode.
- Approve/order actions render their block reason verbatim
  (`blocked: STALE price (12s)`).
- Timelines show **explicit gap markers** and never interpolate.

These rules are pure functions with unit tests (run by `make check` too), so UI
behaviour is pinned without a browser.

## Load pattern

Each route has a `+page.ts` `load` (SSR: the first paint already carries real
data and a real badge) plus an `onMount` refresh on the route's own cadence.
`setInterval` is deliberately **not** at component top level — that would keep
running during SSR in the node/worker runtime.

## Known gap (recorded, not silent)

The Workers API currently exposes GETs for health, recovery log and watches
only. `/signals`, `/analysis`, `/approvals`, `/orders`, `/strategy` therefore
render **UNAVAILABLE** today — the fail-closed behaviour above, not a crash.
Their read endpoints land with the BFF wiring at E12.

