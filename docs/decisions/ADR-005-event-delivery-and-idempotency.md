# ADR-005 — Event Delivery & Idempotency

Status: PROPOSED | Date: 2026-10-10

## Context
At-least-once delivery across Redis→Workers→D1→exchange.

## Decision
At-least-once + dedupe (UNIQUE dedupe_key) + transactional outbox + idempotent exchange submit (clientOrderId) + reconcile-to-terminal. Never claim exactly-once.

## Alternatives
A: Exactly-once claim — rejected (no basis). B: Best-effort fire-forget — rejected (loss/duplicates).

## Verification
Duplicate-delivery + ack-loss tests; reconcile drill in E09.
