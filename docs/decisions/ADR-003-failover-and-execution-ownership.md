# ADR-003 — Failover & Execution Ownership (one submitter, fenced by epoch)

Status: ACCEPTED (2026-10-10) | Relates: §06, E06/E09

## Context
During failover two subsystems (returning Go path + fallback coordinators) could both believe they own submission, causing duplicate orders — the highest-severity failure in this system.

## Decision
- Singleton `ExecutionAuthority` DO holds `{holder, epoch, expires_at}`. Lease TTL 30s, renew 10s. Every submit carries `(holder, epoch)`; mismatch → reject + `lease.fenced` event.
- Fallback evaluates triggers via sharded `WatchCoordinator-{N}` on REST data but submits only when `FALLBACK_ORDERS_ENABLED` (default false) AND fresh + approved + risk-pass + lease held.
- Return-to-primary requires: Go healthy 60s → reconcile all non-terminal intents → drain fallback → epoch-bump handoff → PRIMARY event.

## Alternatives
- A: No lease (cooperative) — rejected (no fencing = duplicates possible).
- B: D1 row-lock — rejected (consistency/latency under contention, no wait-queue semantics).
- C: Halt all orders in fallback — kept as the default config, not the architecture (flag allows future supervised use with new ADR).

## Verification
Split-brain unit test (two racers, one fenced), E06-T02 kill-both drill asserting zero duplicate intents.
