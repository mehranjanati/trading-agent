# 01 — Product Requirements (FR / NFR / SAFE traceability)

**Status:** APPROVED baseline | Legend: acceptance uses Given/When/Then. Each FR traces to design (§) and backlog task.

## 1. Functional requirements

### Watches & market data
- **FR-001 Create/cancel Watch** — Given a valid symbol and trigger JSON When the trader posts `/api/watches` Then a versioned Watch is persisted in D1, cached in Redis, and visible in the dashboard. Traces: §04, §10 · Task E05-T01. Out: no auto-trading.
- **FR-002 Normalized price stream** — Given the Toobit WS is up When ticks arrive Then Go publishes `{symbol, px, ts, src}` with server timestamps and freshness metadata. Traces: §03 · E02-T02.
- **FR-003 Deduplicated trigger events** — Given a trigger condition fires When the Watcher emits `watch.triggered_v1` Then exactly one durable event per `(watch_id, trigger_seq)` exists (UNIQUE dedupe_key). Traces: §05 · E03-T01.
- **FR-004 Stale-data hold** — Given price age exceeds the per-symbol threshold When a trigger would fire Then the trigger is held as `HELD_STALE` and surfaced, never evaluated on stale data. Traces: §06 · E03-T02.

### Signals, analysis, approval
- **FR-005 Signal ingestion (5 kinds)** — Given a signed payload of kind `DIVERGENCE_TRIPLE | ORDER_BLOCK | OB_OS | MTF | REGIME` When posted to `/api/signals:ingest` Then it is schema-validated, stored with source+timestamp, and linked to a Watch. Traces: §03 · E07-T01.
- **FR-006 Advisory AI analysis** — Given a triggered Watch + signals When an analysis run executes Then it stores `{bias, confidence, invalidation_refs, model, input_hash}` and never emits an order. Traces: §03 · E05-T01.
- **FR-007 Human approval (single-use, expiring)** — Given an analysis run When the trader approves Then a one-time token with 10-minute expiry is issued; reuse or post-expiry use returns 410. Traces: §08 · E08-T02.
- **FR-015 Market-regime veto (per-watch)** — Given a watch armed with `regime_filter=true` When its analysis run executes Then the Worker evaluates the ETHBTC / USDT.D / BTC.D / TOTAL3 trends against their EMA-50 before the engine is consulted: a hostile regime (`VETO` + `action_on_veto=BLOCK`) stores `bias=FLAT, confidence=0` without calling the engine, while `WARN` (CHOP/UNKNOWN) keeps the engine bias with confidence reduced by `confidence_penalty`. A missing index feed is `UNKNOWN`, never a pass. Traces: §08 §8.2a · E11-T01.

### Risk, execution, positions
- **FR-008 Deterministic risk gates** — Given an order intent When validated Then leverage, notional, concurrent-exposure, symbol-allowlist, freshness and kill-switch gates run in code with reason codes (`R-LEV`, `R-NOT`, `R-EXP`, `R-SYM`, `R-STALE`, `R-KILL`). AI output is an input, never an override. Traces: §08 · E08-T01.
- **FR-009 Idempotent submit + reconcile** — Given a risk-passed intent with `client_order_id=intent_id` When submitted Then retries reuse the same ID and a reconcile loop polls to a terminal state (`FILLED | REJECTED | CANCELLED | EXPIRED`); `SUBMIT_UNKNOWN` never resubmits blindly. Traces: §05, §08 · E09-T01.
- **FR-010 Position snapshots** — Given reconciled fills When positions change Then a snapshot `{symbol, size, entry_px, leverage, at}` is written; positions are never derived from intents. Traces: §04 · E09-T01.
- **FR-011 Kill switch** — Given the switch is engaged When any new-order path is hit Then it halts in <5s with actor+reason logged; existing reconcile continues. Traces: §08 · E09-T01.

### Failover & dashboard
- **FR-012 Degraded fallback** — Given Go/Redis loss When fallback engages Then Workers load ACTIVE Watches from D1, REST-poll within rate limits, banner the dashboard, and block new orders if state or data is uncertain. Traces: §06 · E06-T02.
- **FR-013 Dashboard (11 views + freshness)** — Given any system state When the trader opens the dashboard Then system health, signals, watches, zones, events, analysis, approvals, orders, failover history, logs and strategy config are visible, each labelled LIVE/STALE/CACHED/UNAVAILABLE. Traces: §09 · E10-T01.
- **FR-014 Audit timeline** — Given any state transition When it occurs Then an append-only event + actor + timestamp row exists and is queryable per entity. Traces: §04, §05 · E04-T02.

## 2. Non-functional requirements
- **NFR-001 Freshness transparency** — every price/position/order view shows data age; default stale threshold 5s (per-symbol override, Q-04).
- **NFR-002 Independent availability** — dashboard+control API availability is reported separately from execution availability.
- **NFR-003 Recoverability** — RPO zero for D1 business state; RTO primary <5min, degraded fallback <2min.
- **NFR-004 Auditability** — 100% of order-path transitions have event rows; no silent transitions.
- **NFR-005 Security** — no secrets in repo (CI-enforced), trade-only Toobit keys, IP allowlist, RBAC, rate limits.
- **NFR-006 Rate compliance** — never exceed documented Toobit limits; fallback poll math in ADR-004 (VERIFY_REQUIRED).
- **NFR-007 Operability** — `make check` green per commit; rollback <5min; runbooks in §12.

## 3. User journeys
- **J1 Happy path:** create Watch → trigger → signals → analysis → approve → risk pass → submit → reconcile → position. Dashboard shows each hop with evt IDs.
- **J2 Failover drill:** kill Go → DEGRADED banner → fallback restores Watches → Go returns → lease handoff → PRIMARY, zero duplicate intents.
- **J3 Risk reject:** over-leverage intent → `R-LEV` with limit/asked values → trader adjusts → resubmits as new intent.
- **J4 Unknown outcome:** ack lost → `SUBMIT_UNKNOWN` → auto-reconcile → terminal state + alert if >5min.

## 4. MVP boundary
IN: paper/testnet loop, approval, risk, failover drills, dashboard, 14-day paper gate. OUT: live trading, auto-trade flag, withdrawals, profit guarantees, tick store in D1.

Related: [Charter](./00-project-charter.md) · [Architecture](./02-system-architecture.md) · [Risk](./08-trading-risk-and-execution-safety.md).
