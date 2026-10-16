# 05 — Events & State Machines (envelopes · FSMs · outbox · sequences)

## 5.1 Event envelope (v1, JSON-schema in `schemas/event-envelope.schema.json`)
`{id: evt_<ulid>, type, v:1, entity_id, seq, ts, actor, dedupe_key, payload}`. `dedupe_key = type:entity_id:seq` UNIQUE in D1. Ordering: causal per `entity_id` via `seq`; no global ordering claim. Delivery: at-least-once; consumers dedupe. Retries exp-backoff 1s→5min, DLQ after 10 attempts with alert.

## 5.2 Canonical event types
`watch.created|triggered|held_stale|held_uncertain|invalidated|expired|closed` · `signal.ingested` · `analysis.completed` · `approval.requested|granted|rejected|expired|consumed` · `risk.passed|rejected` · `order.intent|submitted|ack_lost|acked|partial|filled|rejected|cancelled|expired` · `position.snapshot` · `health.degraded|recovered` · `lease.acquired|fenced|released` · `kill.engaged|released`.

## 5.3 Watch FSM
```mermaid
stateDiagram-v2
  DRAFT --> ACTIVE: publish
  ACTIVE --> TRIGGERED: fresh trigger
  ACTIVE --> INVALIDATED: invalidation hit
  ACTIVE --> EXPIRED: expiry
  TRIGGERED --> ANALYZED: analysis stored
  ANALYZED --> APPROVED: grant (single-use)
  ANALYZED --> CLOSED: reject
  APPROVED --> ORDERED: risk pass + submit
  APPROVED --> CLOSED: risk reject/expired
  ORDERED --> CLOSED: terminal order
```
Guards: only ACTIVE evaluates; TRIGGERED needs fresh px; APPROVED needs unused+unexpired approval; every edge writes `watch_transitions` + event.

The `DRAFT→ACTIVE` ("publish") edge is performed by the human Stalk click: `POST /api/watches` inserts the row `DRAFT` v1 and publishes it to `ACTIVE` v2 in the same D1 batch (reason `publish (stalk)`), because the trigger loop and the ADR-004 poller evaluate `status='ACTIVE'` only — an unpublished draft is a zone nothing ever watches. Arming is advisory, never an order: a trigger still leads to analysis, and the order path needs its own single-use human approval (SAFE-002).

### 5.3a Who evaluates, and how an edge reaches D1

`ACTIVE → TRIGGERED|INVALIDATED` is decided by the Go trigger loop
(`go-watcher/triggerloop` + `tickfeed`): a 10s snapshot reload of the ACTIVE set,
a live tick source (`TRIGGER_FEED=rest` — the ADR-004 price poll; `ws` — the
production socket feed), a pure deterministic evaluator, and one POST per edge to
`POST /api/watches:trigger`. The Worker owns the transaction (the Go plane never
writes D1): FSM-guarded transition + event + outbox, then the advisory analysis
run and `TRIGGERED → ANALYZED`. A replay, a stale evaluation version or a watch
that is no longer ACTIVE is answered 200 with an explicit reason and writes
nothing — the loop must be able to retry safely. If the analysis engine is
unreachable the watch stays `TRIGGERED` and no analysis row is written.

## 5.4 Order FSM
```mermaid
stateDiagram-v2
  INTENT --> RISK_PASSED
  INTENT --> RISK_REJECTED
  RISK_PASSED --> SUBMITTED
  SUBMITTED --> SUBMIT_UNKNOWN: ack lost/timeout
  SUBMITTED --> ACKED
  SUBMIT_UNKNOWN --> ACKED: reconcile found
  SUBMIT_UNKNOWN --> REJECTED: reconcile absent
  ACKED --> PARTIAL --> FILLED
  ACKED --> FILLED
  state ACKED etc --> REJECTED
  state ACKED etc --> CANCELLED
  state ACKED etc --> EXPIRED
```
Rules: `SUBMIT_UNKNOWN` = reconcile-only with same `client_order_id`; never blind-resubmit; alert >5min unresolved.

## 5.5 Transactional outbox
D1 batch: business row + `outbox` row atomically → relay (Workers) publishes to Streams/fanout → `done=1` on ack, else `next_retry` backoff. Consumers idempotent on `dedupe_key`.

## 5.6 Key sequences
```mermaid
sequenceDiagram
  participant T as Toobit WS/REST
  participant G as Go Watcher
  participant R as Redis Streams
  participant W as Workers
  participant D as D1
  participant H as Human
  T->>G: tick
  G->>R: XADD watch.triggered (evt_id)
  R->>W: XREADGROUP cg-workers
  W->>D: batch(event+transition+outbox)
  W->>W: analysis run
  W->>H: approval request
  H->>W: grant (single-use, 10m)
  W->>W: risk PASS
  W->>T: POST order {clientOrderId}
  T-->>W: timeout (ack lost)
  W->>D: SUBMIT_UNKNOWN
  W->>T: GET order?clientId=... (reconcile)
  T->>W: ACKED/FILLED
```
Recovery variant: on boot, Workers sweep non-terminal intents → reconcile each by `client_order_id` before accepting new submits.
