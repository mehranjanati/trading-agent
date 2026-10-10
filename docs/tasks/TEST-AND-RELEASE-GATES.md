# Test & Release Gates (entry/exit per epic + human release gate)

## Per-epic exit gates (evidence required)
| Epic | Gate | Evidence |
|---|---|---|
| E00 | `make check` green, template live | CI link |
| E01 | scan fixture red, RBAC matrix approved | CI log + matrix |
| E02 | 24h soak log, flap 10/10, URL+date | soak log + ADR-004 |
| E03 | replay golden match, restart counts equal | test output |
| E04 | dedupe enforced, relay redelivery test | D1 test log |
| E05 | idempotency replay, split-brain fenced | contract + DO test |
| E06 | kill-Go/Redis/both drills, 429-free polls | drill logs + incidents |
| E07 | 5-kind schema tests, version pin | test output |
| E08 | 8-code matrix 100%, race 1-winner | coverage report |
| E09 | ack-loss 1-order proof, kill <5s | testnet log |
| E10 | degraded-UX + badge coverage | screenshots/test |
| E12 | rollback <5min, alert routing | drill log |
| E11 | 14d paper, zero unapproved, signed report | gate report |

## Human release gate (blocking)
1. All P0 tasks DONE. 2. E11 report filed with zero unapproved orders. 3. Security review (T-01..T-08) signed. 4. Explicit approval row in `recovery_log` with approver + scope. Until then: paper/testnet only; `LIVE_TRADING_ENABLED` does not exist; any live-enabling PR is rejected without a new ADR.
