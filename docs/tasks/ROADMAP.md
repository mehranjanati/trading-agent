# Roadmap (wave plan + dependency order + staffing notes)

## Wave 0 — Foundation (P0) · start now
1. **E00-T02** IN_REVIEW → merge (human confirms template). 2. **E01-T01** env+secrets (unblocks E04). 3. **E01-T02** RBAC+key policy (unblocks E05/E09). 4. **E04-T01 → E04-T02** D1 schema+repos (unblocks E02-T01, E03-T02, E05).

## Wave 1 — Primary path (P1) · needs Toobit verification
5. **E02-T01** doc verification (BLOCKED A-01/A-02) — researcher captures URL+date, answers Q-03/Q-10. 6. **E02-T02 → E03-T01 → E03-T02** Go connector+watcher. 7. **E05-T01 → E05-T02** control API + lease/shards. 8. **E07-T01** signals (parallel with E05-T02). 9. **E12-T01** envs+alerts early (supports soak).

## Wave 2 — Safety (P0) · adversarial review required
10. **E06-T01 → E06-T02** health + kill drills (GLM-5.3 author, Max review). 11. **E08-T01 → E08-T02** risk + approvals. 12. **E09-T01** submit+reconcile on testnet/paper-sim.

## Wave 3 — Ops & proof (P1/P0)
13. **E10-T01** SvelteKit dashboard (Q-01 decided). 14. **E11-T01** full suites + 14-day paper → signed gate report.

## Wave 4 — Go/WASM strategy runtime (PLAN ONLY, WASM-only, no Web3)
15. **E13-T01 DONE** (contract v1 schemas + golden fixtures + validator in `make check`). 16. **E13-T02** host boundary + lifecycle design, and **E13-T03** compat matrix (parallel) → **E13-T04** persistence/ops → **E13-T05** MVP slice → **E13-T06** safety sign-off. Paper-only; no runtime code until E13-T06 signed.

## Wave 5 — Trading cockpit (PROPOSED, P1) · does not touch the trading path
17. **E15-T01** (docs/20, ADR-012): one cockpit + three views, legacy routes redirect
    with state preserved, badges/mode banner/venue notice unchanged, dashboard stays
    read-only (D-08). Slices S1 shell → S2 panels → S3 inline assistant → S4 redirects;
    legacy pages are deleted only after their redirect is live.

## Wave 6 — Live-trading readiness (PROPOSED, GATED on SAFE-007)
18. **E16-T01** (docs/21, ADR-013): P0 14-day paper proof → P1 signed adapter →
    P2 fail-closed env gate → P3 live-only controls (recvWindow, position/margin mode,
    funding/liquidation, close-all, key-rotation drill) → P4 two-person first order.
    **Nothing in this wave may be implemented as a flag flip**; `LIVE_TRADING_ENABLED`
    must not exist in any deploy until docs/21 §21.9 is signed (docs/13 §13.8).

## Critical path
E00 → E01 → E04 → E05 → E06 → E08 → E09 → E11. E02/E03 join after A-01 clears. E10/E12 parallelize after E05-T01. E15 is off the trading critical path (UI only); E16 depends on E11 and blocks only live capability.

## Release gate
No live-trading capability without: all P0 DONE + paper report + security review + signed `recovery_log` row. See `TEST-AND-RELEASE-GATES.md` and docs/21 §21.9.
