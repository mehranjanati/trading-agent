## Task
- ID: <!-- e.g. E01-T01 -->
- Epic: <!-- E00..E12 -->

## What & why
<!-- objective + linked docs -->

## Risk label (pick one)
- [ ] `risk:none` — docs/scaffold only
- [ ] `risk:low` — non-safety code
- [ ] `risk:high-safety` — touches risk/approval/execution/failover/secrets

## Tests
- [ ] `make check` green
- [ ] New/updated tests: <!-- list or N/A with reason -->
- [ ] Safety-path coverage (if risk:high-safety): <!-- reject paths, drills -->

## Docs refs
<!-- e.g. docs/08-trading-risk-and-execution-safety.md SAFE-003 -->

## Safety checklist (required if risk:high-safety)
- [ ] No secrets committed (`make check` secret-scan green)
- [ ] No live-trading enablement, no withdrawal code
- [ ] Human approval path untouched or explicitly reviewed
- [ ] Idempotency + reconcile considered (E09 paths)
- [ ] Reviewer differs from author model (see docs/15)

## Screenshots / evidence
<!-- CI link, drill output, paper-run excerpt -->
