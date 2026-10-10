# Roadmap (dependency order)

## Wave 0 — Foundation (P0)
E00 repo conventions → E01 config/secrets → E04 D1 schema/outbox.

## Wave 1 — Primary path (P1)
E02 Toobit connector → E03 Watcher+Redis → E05 Workers+DO → E07 signals.

## Wave 2 — Safety (P0)
E06 failover/leases → E08 risk+approval → E09 execution+reconcile (test-gated).

## Wave 3 — Ops (P1/P0)
E10 dashboard → E12 deploy/monitor → E11 full simulation + paper-trading (14d).

## Release gate
Explicit human authorization before any live-trading capability. See `TEST-AND-RELEASE-GATES.md`.
