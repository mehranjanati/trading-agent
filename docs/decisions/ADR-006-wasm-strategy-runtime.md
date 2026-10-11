# ADR-006 — Go/WASM Strategy Runtime (wazero, modular monolith)

Status: PROPOSED 2026-10-11 | Relates: docs 02,03,17, E07,E13 | Deciders: human + architect

## Context
Strategies are versioned JSON configs (`strategy_configs`); trigger logic is fixed Go (`trigger.Eval`). AI-generated strategies need executable, versioned, rollback-safe modules without rebuilding the server or weakening SAFE-001..006.

## Decision
- Embed wazero (pure-Go, no cgo) in `go-watcher/strategy/` (modular monolith). No new service.
- Language Go, target GOOS=wasip1 GOARCH=wasm, offline builds. Fresh instance per invocation (MVP).
- stdin/stdout JSON contract v1; stderr diagnostics only. 500ms deadline, 64KB caps.
- Output = signal proposals only; existing approval+risk+execution authoritative.

## Alternatives
- A: Extism — rejected MVP (extra SDK surface; revisit if multi-language needed).
- B: Wasmtime via cgo — rejected (cgo ops burden on Hetzner).
- C: Native Go plugins — rejected (no isolation, rebuild/deploy coupling).
- D: Pool instances — deferred (leakage risk; measure first).

## Consequences
+ versioned strategies w/o server rebuild; + isolation boundary. - WASI/stdlib limits to verify; - latency overhead to measure.

## Verification
P0-C feasibility matrix (go1.23 x wasip1 x wazero ver); PoC compile+invoke sma-cross; latency/mem report; no-merge until green.
