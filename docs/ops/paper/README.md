# Paper-run protocol (E11-T01) — the 14-day gate

The gate is **calendar time + evidence + a human signature** (docs/00 S-01,
docs/11 §11.1, SAFE-007). None of the three can be compressed: 14 days means 14
consecutive days of the deployed loop, the evidence is what the loop produced,
and the signature is a human decision on day 14.

## The one number

`unapproved_count` — order intents that do not trace to a **consumed**
approval (SAFE-002). It must be **0 every day**. One nonzero day resets the
window (a red day is a red day; docs/tasks/TEST-AND-RELEASE-GATES.md).

## Cadence

| When | What | Tool |
|---|---|---|
| deploy (E12) | the loop goes live on the real stack; day 1 begins | E12 runbook |
| every cycle | signal → analysis → **human approval** → submit → reconcile → position | `scripts/paper-cycle.mjs` |
| nightly | the day's report: `unapproved_count`, single-use, unknowns, terminal coverage, `paper_only`, suites ref | `scripts/nightly-report.mjs --db … --day N --suites-json …` |
| day 14 | the gate report is **signed by a human** and filed | the report's `signed_by` |

## Machinery (built here, proven locally)

- `scripts/paper-gate.mjs` — the pure audit: intents↔approvals traceability,
  approval reuse, lingering `SUBMIT_UNKNOWN` (>5min), terminal coverage, the
  `LIVE_*` env namespace (SAFE-007), and the report verdict. Unit-tested in
  `scripts/paper-gate.test.mjs` (runs inside `make check`).
- `scripts/paper-cycle.mjs` — one full J1 cycle: authenticated signal webhook →
  analysis → **the human approval** (recorded with its maker) → submit → verify.
  Evidence lands here as `cycle-<UTC>.json`.
- `scripts/nightly-report.mjs` — the daily report; refuses `PASS` without the
  CI/suites reference.

## Honest state

- **Proven:** one full cycle end-to-end with `unapproved_count = 0`
  (`cycle-*.json` in this directory), and a day-1 report where every check is
  green **but `signed_by` is null** — the human has not signed, and day 1 is not
  day 14.
- **Pending:** the 14 consecutive days themselves. They start when the deployed
  stack runs continuously (E12) — the paper run on a laptop is not the run the
  gate talks about. Until then E11-T01 stays IN_PROGRESS and the human release
  gate stays closed (paper only; `LIVE_TRADING_ENABLED` does not exist).

## Notes

- Approvals in the real run come from the dashboard by the human trader;
  `--approved-by` in the cycle driver is the local-demonstration record of that
  human step, and the report stores the identity either way.
- Paper market data: the stub/simulator quote lands in the same snapshot the
  poller writes; in PRIMARY the Go WS feed owns freshness (E12 wiring), and a
  submit with no price fails closed (R-NOT/R-STALE).