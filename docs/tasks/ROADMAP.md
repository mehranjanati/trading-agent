# Roadmap (wave plan + dependency order + staffing notes)

## Wave 0 — Foundation (P0) · start now
1. **E00-T02** IN_REVIEW → merge (human confirms template). 2. **E01-T01** env+secrets (unblocks E04). 3. **E01-T02** RBAC+key policy (unblocks E05/E09). 4. **E04-T01 → E04-T02** D1 schema+repos (unblocks E02-T01, E03-T02, E05).

## Wave 1 — Primary path (P1) · needs Toobit verification
5. **E02-T01** doc verification (BLOCKED A-01/A-02) — researcher captures URL+date, answers Q-03/Q-10. 6. **E02-T02 → E03-T01 → E03-T02** Go connector+watcher. 7. **E05-T01 → E05-T02** control API + lease/shards. 8. **E07-T01** signals (parallel with E05-T02). 9. **E12-T01** envs+alerts early (supports soak).

## Wave 2 — Safety (P0) · adversarial review required
10. **E06-T01 → E06-T02** health + kill drills (GLM-5.3 author, Max review). 11. **E08-T01 → E08-T02** risk + approvals. 12. **E09-T01** submit+reconcile on testnet/paper-sim.

## Wave 3 — Ops & proof (P1/P0)
13. **E10-T01** SvelteKit dashboard (Q-01 decided). 14. **E11-T01** full suites + 14-day paper → signed gate report.

## Critical path
E00 → E01 → E04 → E05 → E06 → E08 → E09 → E11. E02/E03 join after A-01 clears. E10/E12 parallelize after E05-T01.

## Release gate
No live-trading capability without: all P0 DONE + paper report + security review + signed `recovery_log` row. See `TEST-AND-RELEASE-GATES.md`.
