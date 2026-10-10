# ADR-002 — Persistence & Recovery (D1 canonical, Redis recoverable, DO coordinating)

Status: ACCEPTED (2026-10-10) | Relates: §04, §06, E04/E03/E06

## Context
Trigger decisions need millisecond state; business truth needs zero-loss durability and auditability. One store cannot serve both without compromise.

## Decision
- **D1 is the sole canonical store** for watches, transitions, signals, events, runs, approvals, intents, orders, positions, outbox, health and recovery log. RPO zero; PITR backups.
- **Redis is a recoverable cache + replayable buffer** (Streams, consumer acks, MAXLEN trim). Any Redis content can be rebuilt from D1 snapshot + last-acked stream ID.
- **Durable Objects persist only leases + shard cursors**; they coordinate, never serve as the price or order store.
- **Go boots from `GET /api/watches/active-snapshot`** and resumes streams from the last acked ID.

## Alternatives
- A: Redis as truth — rejected (persistence/ops risk, harder audit).
- B: Tick store in D1 — rejected (write volume, cost, not needed for decisions).
- C: DO SQLite as truth — rejected (ownership split, limits, weaker query story for audit).

## Consequences
+ Restart-safe primary; + single audit source. − Outbox relay to maintain; − snapshot endpoint is load-bearing (tested in E03-T02/E06-T02).

## Verification
Kill-restart test (identical ACTIVE set), Redis-flush drill, dedupe test on replayed events.
