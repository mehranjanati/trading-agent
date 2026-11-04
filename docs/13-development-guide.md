# 13 — Development Guide (normative rules for every future task, human or AI)

## 13.1 Layout & boundaries
`go-watcher/` (Go only) · `workers/` (TS, control plane) · `dashboard/` (SvelteKit) · `migrations/` (D1 forward-only) · `schemas/` (JSON-schema, shared contract) · `docs/` · `scripts/`. Go never imports Workers code; shared types come from `schemas/` + `docs/10`. New module? Propose in PR with ADR ref.

## 13.2 Local setup
Prereqs: Go 1.23+, Node 20+, wrangler, redis-stack. `cp .env.example .env` (paper defaults). `make dev` runs Go + Redis + Workers-local + dashboard with `HUMAN_APPROVAL_REQUIRED=true` forced. No live keys on laptops.

**Stack rule (binding): TypeScript + Go only — no Python anywhere** (scripts, CI, generators, docs examples, task outputs). Node (`.mjs`) for repo scripts, Go for services/tests. Violations fail review.

## 13.3 Quality gates
- Go: `gofmt -l`, `go vet`, unit cov ≥80% on `watcher/`, `risk/`-adjacent code (none in Go, but trigger logic counts).
- TS: `eslint`, `tsc --noEmit`, no `any` in approval/risk/execution paths, zod/io-ts validation at API boundary.
- Every PR: `make check` green, task ID in title, risk label, docs refs, tests or explicit N/A justification.

## 13.4 Migrations & schema
Forward-only `NNNN_desc.sql`; each migration has up-only SQL + rollback *plan* in comments. `events.dedupe_key` UNIQUE is load-bearing — never drop. Schema change → update §04 + JSON-schema + contract test in same PR.

## 13.5 Safety rules for AI tasks
- Never invent Toobit limits — mark VERIFY_REQUIRED + file E02-T01-style research subtask.
- Never add auto-trade, withdrawal, or live-enable flags without ADR + human sign-off.
- Safety-path changes need a reviewer model different from the author (see `15-model-routing`).
- Record model + date in PR description for E06/E08/E09 changes.

## 13.6 Bot-run & strategy rules (docs/19, binding)
- Every new strategy follows docs/19 §19.6: standalone module (own `go.mod`, stdlib-only), stdin/stdout contract v1, `make strategy-build SRC=… ID=… VERSION=…`, registry row, golden fixtures pass, `analyze-live` reproduces `POST /analyze`.
- New work pins `Registry.Active()` only — never pin `retired` for a new run (ADR-011).
- `aggregate.confidence` is a vote share, not a win probability — never display it as predicted return (SAFE-009).
- `PreviousState` stays `{}` until the `strat:state:{id}` checkpoint path (docs/17 §17.3) is implemented; stateful strategies must document the gap in the PR.
- Paper-only until gate: no change in this doc enables live trading.

## 13.7 UI rules (docs/20, ADR-012 — binding for dashboard work)

- The target information architecture is **one cockpit + three secondary views**
  (`/cockpit`, `/execution`, `/activity`, `/settings`); docs/20 is normative for
  new UI work and for the legacy-route redirect table.
- The dashboard stays **read-only** (D-08). The only write any view may perform is
  `POST /api/watches`; approvals/orders have no action button and gain none
  without a new ADR + security review.
- Every data widget keeps **its own** freshness badge; merging views must never
  merge badges, and a failed read renders UNAVAILABLE (never an empty table).
- The mode banner, the gap-explicit `timeline()`, and the paper-sim venue notice
  survive any refactor.
- New pure UI logic lands in `dashboard/src/lib/*-core.mjs` so `node --test` can
  cover it (the `freshness.mjs` / `setups-core.mjs` / `library-core.mjs` pattern);
  `.svelte` files stay thin.
- Legacy routes are removed only after their redirect is live in production.

## 13.8 Live-trading change rules (docs/21, ADR-013 — binding until the gate is signed)

- **No live-enable flag may be added without ADR-013 reviewed and signed by a
  human.** Adding `LIVE_TRADING_ENABLED` (or any equivalent) without the SAFE-007
  paper proof is a review-blocking defect, not a feature.
- The venue is chosen in **exactly one place** (the exchange factory in
  `workers/src/exchange.mjs`); no other module may branch on `ENV !== "paper"`.
- The live adapter must implement the same `submit()` / `query()` contract as the
  paper simulator, keep `VENUE_STATUS_MAP` as the only status translation, and
  turn 5xx/timeout into `ackLost()` → `SUBMIT_UNKNOWN` (never a resubmit).
- Boot fails closed on half-configuration (`ENV=live` without keys, or the flag
  without `ENV=live`). A live-capable but misconfigured process must not start.
- Trade-scope keys only (SAFE-008); secrets in the Cloudflare store only; never
  log a signature or a key.
- The risk gate order, single-use approval, `client_order_id = intent_id`,
  positions-from-fills, and D-08 are **not** up for negotiation in a live change:
  a diff that touches them needs its own ADR and a separate security review.
