# ADR-002 — Persistence & Recovery

Status: PROPOSED | Date: 2026-10-10

## Context
Fast cache vs durable truth; restart without loss.

## Decision
D1 canonical for Watches, events, approvals, intents, orders, audit. Redis recoverable cache + replayable Streams buffer. DO persists leases/cursors only. Go boots from D1 snapshot.

## Alternatives
A: Redis as truth — rejected (durability/ops risk). B: Ticks in D1 — rejected (cost/scale). C: DO as truth — rejected (scope/limits).

## Consequences
+ RPO-zero business state; − must maintain snapshot endpoint + outbox relay.

## Verification
Kill-Restart test asserts watch set identical; Redis loss drill in E06.
