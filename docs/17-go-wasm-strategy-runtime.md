# 17 — Go/WASM Strategy Runtime Plan (WASM-only scope)

**Status:** PROPOSED 2026-10-11 | **Scope:** Go/WASM only. Web3 OUT. | **Mode:** PLANNING_ONLY.

## 17.1 Verified current state

- `go-watcher/go.mod`: `module trading-agent/go-watcher`, `go 1.23`. Local `go1.27.0 darwin/amd64`.
- No `wazero`/`wasip1`/`wasm` refs in repo (grep zero hits).
- `go-watcher/`: `conn` (stdlib WS), `normalize`, `trigger` (pure Eval), `freshness`, `heartbeat`, `snapshot`, `stream`, `redisx` (stdlib RESP, 3s timeout), `metrics`.
- D1 canonical: `strategy_configs(version PK, ...)` + seed `v1-paper` (lev5/notional1000/exposure5000/BTC-ETH-SOL/stale5s/ttl600/minconf0.55). See docs 02/03/04, ADR-001/002.
- Strategy today = versioned JSON config, NOT executable code. Owner: Workers+D1 (E07-T01, E08). Go trigger = level/cross only.
- Safety (doc 08): SAFE-001 fail-closed, SAFE-002 single-use approval, SAFE-003 deterministic risk, SAFE-004 idempotency, SAFE-005 reconcile, SAFE-006 kill-switch. No LIVE flag.
- Tasks: BACKLOG v2.0.0 (21/54), validator scripts/validate-backlog.mjs. Epics E00-E12.

## 17.2 Target: modular-monolith WASM runtime in Go

- Where: new `go-watcher/strategy/` host pkg + `contract/` JSON schema. No new service, no framework swap, no D1/Redis ownership change.
- Runtime: wazero (pure-Go, no cgo) PROPOSED. Verify version vs go1.23 + GOOS=wasip1 GOARCH=wasm before impl (ADR-006).
- Build offline: GOOS=wasip1 GOARCH=wasm go build -o strategy-<id>-<ver>.wasm ./strategies/<id>.
- Model: one bounded eval per trigger/schedule tick. Fresh wazero instance per invocation for MVP (no pooling: avoids cross-call leakage).
- IO: stdin=JSON request, stdout=JSON response, stderr=diagnostics only.
- Contract v1 (JSON, 64KB cap each way): req {contract_version:1, strategy_id, strategy_version, invocation_id:inv_<ulid>, market_snapshot{symbol,px,ts,src,prev_px,stale_s}, strategy_configuration{from strategy_configs}, previous_state{opaque<=4KB}, execution_context{asof_ts,deadline_ms<=500,trace_id}}; resp {contract_version:1, ids echo, status:SIGNAL|NO_SIGNAL|ERROR, decision{bias:LONG|SHORT|FLAT,confidence:0..1}, signals:[proposals], proposed_state, diagnostics{reason,code:OK|VALIDATION|TIMEOUT|CANCELLED|OOM|PANIC|OUTPUT_TOO_LARGE|CONTRACT_MISMATCH,logs[]}}.
- Schemas: `schemas/strategy-invocation.schema.json` + `schemas/strategy-result.schema.json`; golden req/resp fixtures in `schemas/fixtures/` (manifest drives pass/fail expectations); validator `node scripts/validate-strategy-contract.mjs`, regression `node --test scripts/validate-strategy-contract.test.mjs`, wired into `make check` (E13-T01).
- Semantics: invalid/partial output => ERROR, no downstream effect. invocation_id stable => Redis idempotency key wasm:<id>:<ver>:<inv> SET NX TTL 24h.
- Lifecycle (D1 canonical, Redis mirror): draft->validating->validated->active->disabled|failed, +retired. D1 owns registry; Redis holds strat:active:{id}, strat:lease:{inv}, strat:state:{id} checkpoint only. WASM bytes in durable store (Hetzner vol), NOT Redis.
- Pipeline: WASM output = signal proposal -> POST /api/signals:ingest (kind WASM_PROPOSAL) -> analysis -> human approval -> risk -> execution. Module NEVER submits orders, NEVER sees secrets.
- Isolation MVP: wazero no fs/net/env, no host funcs except clock_nanos; deadline 500ms + cancel; stderr<=4KB sanitized. See ADR-006/007/008.

## 17.3 Redis + artifact boundary

- Redis ns: strat:active:{id} HASH{version,sha256,activated_at} no TTL; strat:state:{id} JSON{version,state,at} TTL 7d; strat:lease:{inv} TTL 24h; strat:run:{inv} HASH{status,started,finished} TTL 24h. Atomic state via Lua CAS on (version,inv).
- Artifacts: <store>/strategies/<id>/<ver>/module.wasm + manifest.json{id,ver,sha256,contract_ver,go_ver,flags,built_at,test_report}. Immutable publish (reject overwrite). D1 strategy_artifacts mirrors manifest+status.
- Redis loss => rebuild from D1 active-snapshot (extended strategies[]). Store loss => fail-closed, HELD_UNCERTAIN.

## 17.4 Failures + observability

- Timeout/cancel/OOM/panic => ERROR{code:TIMEOUT|CANCELLED|OOM|PANIC}, metrics wasm_invocations{status}, wasm_duration_ms, /strategy badge+reason; downstream=no signal (SAFE-001).
- Boot: load D1 active set, verify sha256, warm-compile cache, resume strat:state. Stale lease (>2x deadline) ignored.
- Logs {ts, component:wasm-host, trace_id:inv}; alerts: err>5pct/5min, p95>400ms (see doc 09).

## 17.5 MVP slice (solo-dev)

One sample strategy sma-cross-v0.1.0 on BTCUSDT => compile => validate => activate => trigger invoke => proposal in /signals => paper only. No auto-trade, no Web3, no pooling.
