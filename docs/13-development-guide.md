# 13 — Development Guide (rules for future Cline tasks)

- Repo layout: `go-watcher/ workers/ dashboard/ migrations/ docs/`. Boundaries: Go never imports Workers; shared schema via `docs/10` + JSON-schema files.
- Local: Go 1.23+, Node 20+, wrangler, redis-stack; `make dev` runs all with paper mode forced.
- Quality: gofmt/eslint, typed APIs, no `any` in safety paths, PR needs tests+docs refs+risk label.
- Migrations forward-only. Commits: `E..-T..: ...` (e.g. `E01-T01: ...`). Branches: `feat/<EPIC>-<short>`; never push to `main` (see `CONTRIBUTING.md`).
- PRs use `.github/pull_request_template.md` (risk label mandatory); `risk:high-safety` needs human review + safety checklist. Routing via `.github/CODEOWNERS`.
- Migrations forward-only. Safety: never touch keys; never add auto-trade flag without ADR+human gate.
