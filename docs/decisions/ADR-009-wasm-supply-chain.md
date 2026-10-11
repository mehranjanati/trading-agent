# ADR-009 — WASM Supply Chain (AI-generated strategies)

Status: PROPOSED 2026-10-11 | Relates: docs 07,13,17, ADR-006/007/008

## Context
AI-generated Go source must never execute unreviewed. Need source->artifact->activation chain with provenance.

## Decision
- Stages: `generated/` (untrusted source) -> `build/` (reproducible wasip1 compile log) -> `artifacts/` (immutable wasm+manifest) -> D1 registry -> activation. Promotion explicit: draft->validating->validated->active (human/admin per RBAC).
- Manifest records: strategy id/version, sha256, contract_version, go/toolchain version, build flags, built_at, test report ref, source hash, author model + reviewer.
- Guardrails: secret-scan + `go vet` on generated source; deny net/os/syscall imports in guest; contract-version match enforced; overwrite of published version rejected; activation requires admin role + audit row.

## Alternatives
- A: Direct exec of generated code — forbidden.
- B: Auto-promote on build pass — rejected (needs human gate per SAFE-002 lineage).

## Verification
Import-deny test; manifest-field test; overwrite-reject test; unsigned-artifact reject test.
