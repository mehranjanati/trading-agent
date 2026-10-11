# E13 — Go/WASM Strategy Runtime (PLAN ONLY)

Scope: WASM only. No Web3. No runtime code in this phase.

## Phases P0-P4 -> tasks E13-T01..T06

| Task | Title | Deps | Exit |
|---|---|---|---|
| E13-T01 ✅ | P0 audit + contract schema | E07-T01 | DONE — schemas + 4 golden fixtures + validator in `make check` |
| E13-T02 | P1 host boundary + lifecycle design | E13-T01 | host API + FSM + D1 delta documented |
| E13-T03 | P2 feasibility + PoC plan | E13-T01 | compat matrix + PoC scope + bench plan |
| E13-T04 | P3 persistence + ops plan | E13-T02 | Redis keys + artifact store + runbooks |
| E13-T05 | P4 MVP backlog (impl-ready) | E13-T02,T03,T04 | ordered tasks w/ G-W-T + tests |
| E13-T06 | Safety + risk register | E13-T05 | threat table + gates signed |

## E13-T01 evidence (DONE 2026-10-11)

- `schemas/strategy-invocation.schema.json`, `schemas/strategy-result.schema.json` (contract v1).
- `schemas/fixtures/`: golden req/resp (expect ok) + invalid-bias and invalid-deadline (expect fail) driven by `manifest.json`.
- `scripts/validate-strategy-contract.mjs` (stdlib-only draft-07 subset, error paths) run by `make validate`.
- `scripts/validate-strategy-contract.test.mjs` 7/7 pass, wired into `make test`.
- Doc 17.2 + ADR-007 examples synced to schema field names (`strategy_configuration`/`previous_state`/`execution_context`); snippets re-validated against schemas.
- Verified: `make check` green (61 node tests + Go suites + replay/flap/restart drills).



## Testing plan (maps to doc 11)

- Host unit: contract encode/decode, idempotency, CAS state, lifecycle guards.
- Contract: JSON-schema valid/invalid, 64KB caps, partial output => ERROR.
- WASM smoke: compile sma-cross wasip1 + invoke in wazero PoC (P2 only).
- Negative: malformed req, invalid resp, timeout 500ms, cancel, OOM, concurrent version activation (1 winner).
- Integrity: sha256 tamper rejected; publish-overwrite rejected; rollback restores prior validated.
- Recovery: Redis-flush reload; store-down fail-closed; restart restores active set; duplicate inv => cached, no re-exec.
- Regression: trigger golden fixtures unchanged; risk 8-gate matrix green; approval single-use intact; paper boundary (zero unapproved).
- Commands (impl phase): `cd go-watcher && go test ./strategy/...`, `go run ./cmd/replay`, `node scripts/validate-backlog.mjs`.

## Risk register (top)

- R-W1 wasip1 stdlib gaps (net/http/reflect limits) | M/H | pin wazero ver + compat matrix | PoC build log | OPEN.
- R-W2 startup/exec latency | M/M | fresh-instance MVP, measure, budget 500ms | bench report | OPEN.
- R-W3 guest/host state skew | M/M | opaque prev_state<=4KB + CAS + version pin | migration test | OPEN.
- R-W4 Redis eviction/loss | L/H | TTLs + D1 reload + fail-closed | flush drill | mitigated by design.
- R-W5 untrusted AI code | H/H | sandbox deny-all + review + validated-only exec | isolation tests | OPEN.
- R-W6 artifact tamper/version confusion | M/H | sha256 x3 + immutable publish | tamper test | mitigated by design.
- R-W7 concurrent activation | M/M | single-row CAS, 1 winner + event | race test | OPEN.
- R-W8 stale/dup/malformed signals | M/M | freshness gate + idempotency + ERROR sink | replay tests | mitigated.
- R-W9 bypass of risk/approval | H/H | proposals-only + no secret ingress + paper gate | boundary test + audit | mitigated by design.

## Task quality (per docs/tasks/README.md)

Each impl task (E13-T05 children) will carry: id E13-T05-Sn, objective, scope, out-of-scope, deps, affected (provisional go-watcher/strategy/**), steps, G/W/T acceptance, test plan (go test ./strategy/... + fixtures), docs refs (17, ADR-006/007/008, 08), model assignment, complexity S/M, status PROPOSED.

## First milestone (recommended)

E13-T01-S1 contract schema -> E13-T03-S1 compat matrix -> E13-T05-S1 sample strategy fixture. Solo-dev, paper-only, kill-switch enforced.
