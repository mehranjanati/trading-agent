# ADR-005 — Event Delivery & Idempotency (at-least-once + dedupe + outbox)

Status: ACCEPTED (2026-10-10) | Relates: §05, E03/E04/E09

## Context
Events cross Redis Streams → Workers → D1 → (later) exchange REST. Networks fail, acks get lost, consumers crash. We must choose honest guarantees.

## Decision
- **At-least-once delivery everywhere**, with: (a) stable IDs (`evt_<ulid>`, `intent_<ulid>`), (b) `dedupe_key` UNIQUE in D1, (c) transactional outbox (business row + outbox row in one batch), (d) idempotent exchange submit (`client_order_id = intent_id`), (e) reconcile-to-terminal loops.
- Never claim exactly-once. Duplicates are expected and absorbed by constraints + idempotent consumers.
- `SUBMIT_UNKNOWN` is reconcile-only; approvals are single-use (`used_at` atomic consume).

## Alternatives
- A: Exactly-once claim — rejected (no technical basis across WS+Streams+D1+REST).
- B: Best-effort fire-and-forget — rejected (silent loss of triggers/orders).

## Verification
Duplicate-delivery test (same evt twice → one row), ack-loss drill (one exchange order), outbox relay test (kill mid-publish → redeliver → dedupe).
