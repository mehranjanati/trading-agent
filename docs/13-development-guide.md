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
