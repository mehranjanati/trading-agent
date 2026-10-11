# ADR-008 — WASM Persistence, Artifacts, Isolation

Status: PROPOSED 2026-10-11 | Relates: ADR-002, docs 04,06,07,17

## Context
Must place WASM bytes, runtime state, idempotency without violating D1-canonical / Redis-recoverable / DO-coordination (ADR-002).

## Decision
- D1 canonical: strategy_artifacts + strategy_transitions + (extend) strategy_configs. Redis operational only (strat:active/state/lease/run keys, TTLs per doc 17.3). DO untouched (execution lease stays order-path).
- Artifact store: Hetzner volume dir (MVP) `<store>/strategies/<id>/<ver>/{module.wasm,manifest.json}`; immutable; sha256 verified at publish + at load + boot. Redis NEVER default blob store.
- Isolation: wazero deny fs/net/env; allow clock_nanos only; 500ms deadline+cancel; mem cap where supported else documented limit (no hard-CPU claim); fresh instance/call; inputs scrubbed (no keys/secrets); stderr sanitized; Lua CAS state writes.
- Recovery: Redis loss=>D1 snapshot reload; store loss=>fail-closed; boot verifies sha256 + warm-compile.

## Alternatives
- A: Redis blob store — rejected (memory/replication cost).
- B: D1 blob store — rejected (row limits, wrong owner).
- C: S3/R2 now — deferred (no new infra for MVP; revisit w/ ADR).

## Verification
Checksum-tamper test; Redis-flush reload test; store-down fail-closed test; timeout/cancel/OOM tests; secret-scrub test.
