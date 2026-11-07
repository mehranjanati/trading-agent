# ADR-015 — Local Strategy Authoring (IDE instead of in-chat codegen)

Status: ACCEPTED 2026-11-08 | Relates: ADR-006/007/009/011, docs 15,17,19

## Context

Strategy code was produced by a model INSIDE the dashboard chat
(`POST /api/strategy:generate`) and gated by regexes on the Go source
(`workers/src/strategies-ai.mjs`: import allowlist, banned patterns, brace
balance). Three problems surfaced in practice:

1. The gate proved nothing about behaviour. A strategy that compiled and passed
   every regex could still panic on a missing configuration key or drop an echo
   field — the two faults the runner actually rejects. Only executing the bytes
   can show that.
2. The loop was split. Writing/iterating happened in a browser tab with no repo
   context and no compiler; `go build`, the golden fixtures and `wazero` lived on
   the developer's machine, one manual copy-paste away.
3. Publishing was manual and unvalidated: hand-editing `registry.json` was the
   only way to register an artifact, and nothing checked that the row pointed at
   bytes that still matched what was tested (two existing rows,
   `sma-cross@0.1.0` and `@0.2.0`, are byte-identical and differ only by
   configuration — nobody could tell that from the repo).

## Decision

Strategy AUTHORING moves to the IDE/local toolchain; the chat plane keeps only
advisory analysis (market questions, verdict explanation, chart reading).

- `scripts/strategy-new.mjs` scaffolds a standalone module (`strategies/dev/<id>/`)
  from `go-watcher/strategies/template/`, so the envelope the contract depends on
  is copied, never retyped.
- `scripts/strategy-pipeline.mjs` is the SINGLE entrypoint: build (wasip1, pinned
  flags) -> verify -> provenance manifest. Both a developer and CI call it; neither
  reimplements it.
- `go-watcher/cmd/strategy-check` is the verifier: it runs the built bytes through
  the production `strategies.Runner` against the golden fixture plus the failure
  shapes production sends (no candles, one candle, garbage configuration, an
  over-cap deadline, a bare document) and fails on any runner fault code
  (PANIC/TIMEOUT/OOM/OUTPUT_TOO_LARGE/CONTRACT_MISMATCH). A `VALIDATION` answer is
  legal: the strategy declined instead of crashing, which the contract requires.
- `scripts/lint-registry.mjs` validates `registry.json` (unique `id@version`,
  semver, artifact present, status enum, manifest sha256 match) on every PR.
- `scripts/register-strategy.mjs` is the explicit promotion step: dry by default,
  `--activate` to copy the artifact + manifest into `strategies/samples/` and
  append the row. It refuses to overwrite a published `id@version`.
- CI gains a `strategy` job that runs all three.

## Alternatives

- A: Keep in-chat codegen and add a server-side compile+run step. Rejected: the
  Worker cannot run `go build`, and shipping the compiler would put an
  unbounded, unprivileged build farm behind an HTTP route.
- B: Auto-register on build pass. Forbidden by ADR-009 ("auto-promote on build
  pass — rejected"); promotion stays a human action with an audit trail.
- C: Keep the regexes as the only gate. Rejected: a regex cannot observe a panic.
- D: GitHub Actions-only pipeline (no local entrypoint). Rejected: the authoring
  loop needs sub-second feedback; a 1-3 minute round trip per edit turns writing
  one `decide()` into dozens of commits.

## Consequences

- The chat plane no longer generates code; `SYSTEM_PROMPT`, `extractGoCode` and
  `validateGoCode` leave the critical path (deprecated, not secret-bearing).
- A strategy cannot reach `registry.json` without having been executed.
- Artifacts carry provenance (`sha256`, `source_sha256`, `go_version`,
  `build_flags`, `built_at`); the four pre-existing artifacts were backfilled with
  sha256 + source hash marked `provenance: "backfilled"`.
- Cost: authoring requires a local Go toolchain. Accepted — a strategy change is
  a code change, and code changes belong in the repo.
- The lifecycle states `draft|validating|validated` from ADR-007 remain
  unimplemented in D1 (only `active|retired` exist in the filesystem registry);
  the pipeline covers that role until `strategy_artifacts` lands.

## Verification

- `make strategy-check` on a healthy module: 6/6 cases pass, exit 0.
- A module whose `decide()` panics: 0/6, exit 1, artifact refused for
  registration (`strategy-pipeline` fails before the manifest).
- `make strategy-register` without `ACTIVATE=1` leaves `registry.json` and the
  publish dir untouched; with it, the row is appended and `lint-registry` stays
  green.
- `make strategy-template-check` proves the shipped template still satisfies the
  contract (CI invariant).
