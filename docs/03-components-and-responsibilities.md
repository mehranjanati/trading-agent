# 03 — Components & Responsibilities (contracts per component)

## 3.1 Go Watcher (Hetzner) — owner: market intake + triggers
- **Inputs:** Toobit public WS (URL VERIFY_REQUIRED), `GET /api/watches/active-snapshot` (boot reload).
- **Outputs:** Redis `px:{sym}`, Streams `events:market` / `events:watch`, `hb:go:{id}` heartbeat 5s, Prometheus-style metrics (ws_uptime, tick_lag_ms, triggers_fired).
- **Behaviors:** subscribe → normalize `{symbol,px,ts,src,recv_ts}` → in-memory map → evaluate ACTIVE triggers → emit with `evt_<ulid>` → exp-backoff reconnect (1s→60s+jitter, resubscribe) → stale detector per symbol.
- **HTTP (ops only, Fiber or net/http per Q-02):** `GET /healthz` (process), `GET /readyz` (WS+Redis ready), `GET /watches/cache` (cached IDs, no secrets).
- **Must NOT:** write D1, hold approvals/intents, submit orders.
- **Failure:** WS drop → reconnect; Redis drop → buffer in-memory (bounded 10k) then shed+record gap; both down → `/readyz` 503.

## 3.2 Redis — owner: fast state + durable-ish buffer
- **Structures:** `px:{sym}` HASH `{px,ts,src}` TTL 30s · `watch:active:{id}` HASH (no TTL, explicit invalidate) · Streams `events:market|watch|ops` MAXLEN ~100k · consumer group `cg-workers` · `hb:go:{id}` STRING 15s TTL · `lease:mirror` (read-only copy of DO lease for fast check).
- **Consumers:** Workers `cg-workers` with `XREADGROUP`, `XACK` only after D1 batch commit; pending-list reclaimed after 60s.
- **Persistence:** RDB+AOF enabled; loss = replay from D1 snapshot + last-acked stream ID (business-safe).

## 3.3 Workers — owner: control plane + orchestration
- **Routes (v1, auth, see §10):** `POST/GET /api/watches*`, `POST /api/signals:ingest` (HMAC-authenticated webhook, E07-T01-S2b), `POST /api/strategy:activate` (operator/admin), `POST /api/analysis:runs`, `POST /api/approvals`, `POST /api/orders:intents`, `POST /api/kill-switch`, `GET /api/health*`, `GET /api/recovery/log`.
- **Rules:** validate auth → validate schema → check idempotency-key → D1 batch (row+outbox) → relay → respond with IDs. Every mutation returns `trace_id`.
- **Crons:** `*/10s` health evaluator, `*/15s` reconcile sweep, `*/60s` approval-expiry sweeper.

## 3.4 Durable Objects — owner: leases + coordination
- **ExecutionAuthority (singleton):** `acquire(holder,ttl) → {epoch}` · `renew(holder,epoch)` · `release` · `verify(epoch)` on every submit. Only matching `(holder,epoch)` may submit. TTL 30s, renew 10s.
- **WatchCoordinator-{shard} (N=8 default):** owns `hash(symbol)%8` symbols in fallback; stores `{cursor_stream_id, active_ids}`; evaluates triggers on REST-polled data.
- **DashboardFanout:** ephemeral WebSocket fan-out; no durable state; replays from Workers API on reconnect.
- **Persist vs coordinate:** persist leases + cursors; coordinate prices/handoffs (never the price store).

## 3.5 D1 — owner: canonical truth (see §04 for DDL)
Tables: watches, watch_transitions, signals, events, analysis_runs, approvals, order_intents, orders, positions, outbox, health_snapshots, recovery_log, strategy_configs. All writes via Workers batches; reads via indexed queries.

## 3.6 AI Analyst — owner: advisory rationale
- **Input:** trigger + signals + regime + config version hash. **Output:** `{bias: LONG|SHORT|FLAT, confidence 0..1, reasons[], invalidation_refs[], model, input_hash, strategy_version}` stored in `analysis_runs`. No order fields. Low-confidence (<0.55 default) → auto-FLAT with reason.
- **Version pinning (E07-T01-S2a):** `strategy_version` is the active `strategy_configs` version **at run start**, recorded in the run's `output_json`; later activations never rewrite old pins (pin-immutability). Ingested signals likewise carry the schema-registry version they were admitted under (`payload_json._schema_version`).

## 3.7 Risk Engine — owner: deterministic gates (see §08)
Pure function `validate(intent, ctx) → PASS | REJECT(code, detail)`. Gates: R-KILL, R-APPROVAL, R-SYM, R-LEV, R-NOT, R-EXP, R-STALE, R-DUP. Unit-tested matrix, no network calls except clock. Implemented in `workers/src/risk.mjs` (E08-T01): fixed gate order with first-failure-wins, fail-closed on unknown evidence, exact decimal arithmetic, and every verdict echoing the active `strategy_configs` limits version.

## 3.8 Execution — owner: submit + reconcile
`submit(intent)` requires lease epoch + risk PASS + fresh approval; sends signed REST with `clientOrderId`; on timeout → `SUBMIT_UNKNOWN`; `reconcile()` polls to terminal; writes `orders` + `positions` + events.

## 3.9 Dashboard (SvelteKit) — owner: incident-usable UX
Reads Workers BFF only. Every widget shows freshness badge; global mode banner (PRIMARY / DEGRADED / FALLBACK / HALTED). Approve/Reject buttons include reason field + expiry countdown; disabled with tooltip when uncertain.

## 3.10 Exchange boundary
Public WS (no auth) for ticks; signed REST for orders/reconcile. Exact channels + limits VERIFY_REQUIRED in E02-T01 (record URL+date in ADR-004).
