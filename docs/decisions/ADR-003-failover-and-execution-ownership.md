# ADR-003 — Failover & Execution Ownership

Status: PROPOSED | Date: 2026-10-10

## Context
Avoid two active submitters; safe degraded operation.

## Decision
Single `ExecutionAuthority` DO lease (30s, epoch fencing). Only holder submits. Fallback evaluates Watches via sharded coordinators on REST data; blocks orders when uncertain. Return-to-primary requires reconcile of all unknowns + lease handoff.

## Alternatives
A: No lease (hope) — rejected. B: DB-row lock — rejected (D1 consistency/latency). C: Stop-all in fallback — considered; kept as config `FALLBACK_ORDERS_ENABLED=false` default.

## Verification
Split-brain test: two claimants → one fenced; drill in E06.
