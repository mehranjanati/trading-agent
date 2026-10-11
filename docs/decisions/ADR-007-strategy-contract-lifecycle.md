# ADR-007 — Strategy Contract + Lifecycle (v1)

Status: PROPOSED 2026-10-11 | Relates: docs 04,05,08,10,17

## Context
Host/guest need a stable versioned interface; lifecycle needs immutable versions + rollback without breaking D1-canonical rule (ADR-002).

## Decision
- Contract v1 JSON (see doc 17.2): req/resp echo ids; status SIGNAL|NO_SIGNAL|ERROR; decision{bias,confidence}; signals proposals-only; proposed_state opaque<=4KB; diagnostics{reason,code,logs} with code in OK|VALIDATION|TIMEOUT|CANCELLED|OOM|PANIC|OUTPUT_TOO_LARGE|CONTRACT_MISMATCH; diagnostics sanitized. Schemas + golden fixtures + validator: `schemas/strategy-*.schema.json`, `schemas/fixtures/`, `scripts/validate-strategy-contract.mjs` (E13-T01).
- Example req: {"contract_version":"1","strategy_id":"sma-cross","strategy_version":"0.1.0","invocation_id":"inv_01J9Z6Q0M4T7V8X2B3C5D7E9F1","market_snapshot":{"symbol":"BTCUSDT","px":"67234.5","ts":"2026-10-11T12:00:00Z","src":"toobit-ws","prev_px":"67200.0","stale_s":1},"strategy_configuration":{"max_leverage":5},"previous_state":{},"execution_context":{"asof_ts":"2026-10-11T12:00:00Z","deadline_ms":500,"trace_id":"evt_01J9Z6Q0M4T7V8X2B3C5D7E9F1"}}
- Example resp: {"contract_version":"1","strategy_id":"sma-cross","strategy_version":"0.1.0","invocation_id":"inv_01J9Z6Q0M4T7V8X2B3C5D7E9F1","status":"SIGNAL","decision":{"bias":"LONG","confidence":0.62},"signals":[{"kind":"WASM_PROPOSAL","symbol":"BTCUSDT"}],"proposed_state":{"last_bias":"LONG"},"diagnostics":{"reason":"short window crossed above long window","code":"OK","logs":[]}}
- Lifecycle: draft->validating->validated->active->disabled|failed +retired. D1 tables strategy_artifacts(id,version,sha256,contract_version,manifest_json,status,at UNIQUE(id,version)) + strategy_transitions audit. Publish immutable; rollback=re-activate prior validated.
- Idempotency: invocation_id stable; Redis strat:lease:{inv} NX 24h; duplicate => return cached status, no re-exec.

## Alternatives
- A: gRPC/host-funcs per field — rejected (larger surface, harder versioning).
- B: In-band secrets/config — forbidden (T-01).
- C: Mutable versions — rejected (audit break).

## Verification
JSON-schema + golden req/resp; malformed/oversize/partial tests; duplicate-invocation test; rollback test.
