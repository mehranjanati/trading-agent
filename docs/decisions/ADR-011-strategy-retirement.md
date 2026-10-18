# ADR-011 — Retiring a published strategy version (never deleting it)

Status: PROPOSED 2026-10-17 | Relates: ADR-009, ADR-006/007, docs 09/10/17

## Context
A pinned strategy version is immutable (ADR-009: `overwrite of published version
rejected`; the runner executes exact bytes and every analysis run records the
version/hash it used). Traders still need to take a version out of circulation
(bad invalidation distance, superseded logic). Deleting the artifact would break
the two things immutability exists for: an **in-flight** reference (an armed
watch, an approval mid flight, a room/group that pins it) and the
**reproducibility** of already-recorded runs.

Editing the code in place was rejected for the same reason: it would silently
change the meaning of every group/room that references that `id@version`.

## Decision
- A registry row may carry `status`: `"active"` (default when absent) or
  `"retired"`, plus optional `retired_reason`. An unknown value **fails the load**
  (fail closed — a typo must never read as active).
- **Retired ≠ deleted.** The `.wasm` and its `sha256` stay on disk, the version
  stays resolvable (`Registry.Get`) and executable, so in-flight references and
  recorded runs remain valid.
- **Retirement removes selectability.** Callers building a NEW pin set use
  `Registry.Active()`; `Registry.List()` (and `GET /strategies/registry`) still
  serve retired rows with their status, so the UI can show *why* it is not
  offered. The Worker's `analyzeWatch` filters `status !== "retired"` before
  pinning; if nothing active remains the run is DEGRADED and no row is written.
- The dashboard never offers a retired version for a new selection (analysis
  picker, room picker, group tick-list) but keeps it visible and labelled where
  it is already referenced; `strategyUsage` answers "who uses this?" before any
  re-pin/retire decision.
- Changing behaviour = publish a NEW version (`make strategy-build` →
  `registry.json` → sha256), never edit the published one.

## Alternatives
- **Hard delete** — rejected: breaks in-flight references and run reproducibility.
- **Silently hide retired rows** — rejected: a group that pins one would look
  broken ("not in library") instead of "retired, kept for this reference".
- **Edit in place** — forbidden (ADR-009); it makes a group's meaning history-dependent.

## Consequences
- Operators retire by editing `registry.json` (a reviewed PR) — one field, no code.
- A misspelled status is a boot error, not a silent behaviour change.
- Nothing is lost: the catalog grows monotonically, which is what makes an old
  run explainable a year later.

## Verification
`go test ./strategies` — `TestRegistryStatusDefaultsToActive`,
`TestRetiredVersionStaysExecutableButNotSelectable`,
`TestRegistryRejectsUnknownStatus`,
`TestRegistryEndpointServesStatusAndActiveCount`;
`node --test workers/src/trigger.test.mjs` — retired skipped in the new pin set,
all-retired is DEGRADED with no run;
`npm test` (dashboard) — `isRetired` / `selectableCatalog` / `pinnedEntry` status.
