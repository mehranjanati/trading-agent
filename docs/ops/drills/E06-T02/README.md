# E06-T02 drill evidence & notes

Ledger for task **E06-T02 (Failover drills + rejoin)**. Playbook:
[../../../06-failover-and-recovery.md](../../../06-failover-and-recovery.md) · budget math:
[../../../decisions/ADR-004-market-data-fallback.md](../../../decisions/ADR-004-market-data-fallback.md) ·
plan: [../../../tasks/PLAN-E06-T02.md](../../../tasks/PLAN-E06-T02.md).

Evidence files are written by `scripts/chaos.mjs` under `--execute` and named
`<drill>-<UTC>.json` (the harness stamps them; never hand-edited).

## 1. What is proven here (S3)

| Acceptance / gate | Proof | Evidence |
|---|---|---|
| ADR-004 no-429 polls, N=10 | 60 rounds at 5s over 5 simulated minutes, zero 429, peak 110/3000 weight | `budget-*.json` |
| ADR-004 no-429 polls, N=100 | 60 rounds at 5s, zero 429, peak 1200/3000 weight (floor 4s ≤ 5s) | `budget-*.json` |
| AC2 rejoin: non-terminals reconciled pre-PRIMARY | sweep emits `reconcile.complete` with an `at` ≤ the PRIMARY mode row | `workers/src/reconcile.test.mjs` |
| Zero duplicate intents (§6.4) | the sweep only ever UPDATEs; it can never open a second intent for an approval | `workers/src/reconcile.test.mjs` |
| Lease handoff + fencing (§6.3 step 4) | release → acquire bumps the epoch; the zombie's `renew`/`verify` are fenced | `workers/src/rejoin.test.mjs` |
| Fail closed | an unreadable sweep/lease/poller keeps its gate condition unsatisfied | `reconcile` / `fallback-poll` tests |

Re-run the budget proof (localhost only — the stub exchange, no production socket):

```bash
node scripts/chaos.mjs budget --execute --target local --symbols 10  --minutes 5
node scripts/chaos.mjs budget --execute --target local --symbols 100 --minutes 5
node --test workers/src/*.test.mjs
```

The kill drills (S2) run against the local stack and are recorded in the same
directory by `chaos.mjs <go|redis|both|rejoin> --execute --target local --db <local D1>`.

## 1b. What is proven here (S2 kill drills, local 2026-10-12)

| Drill | Evidence | Result | Recovery | Path |
|---|---|---|---|---|
| kill-Go | `go-2026-10-12T09-04-32-985Z.json` | PASS | 60s | PRIMARY → DEGRADED → PRIMARY |
| kill-Redis | `redis-2026-10-12T09-19-50-812Z.json` | PASS | 66s | PRIMARY → DEGRADED → PRIMARY |
| kill-both + rejoin | `both-2026-10-12T09-23-13-071Z.json` | PASS | 66s | PRIMARY → DEGRADED → FALLBACK → DEGRADED → PRIMARY |

Each run asserts: degradation observed; zero duplicate intents per approval
(acceptance 1); all seven health components snapshotted; the ACTIVE set equals
D1 truth in both directions; the `reconcile.complete` incident precedes the
return-to-PRIMARY row (acceptance 2); the lease handoff is recorded with a
monotonic epoch; no `rate_limit_backoff`; and a paper approval is rejected while
degraded. Run with a **fresh seeded DB** per drill — the sweep certifies once
per episode, so a reused DB cannot emit the drill's own `reconcile.complete`.
Central register and re-run recipe: [../../DRILLS.md](../../DRILLS.md).

## 2. Deferrals (recorded, not silent)

1. **Live 429-free run → Hetzner at E12.** This machine has no egress to
   `api.toobit.com`/`stream.toobit.com` (see [go-watcher/SOAK-NOTE.md](../../../../go-watcher/SOAK-NOTE.md)),
   so the proof runs against `scripts/stub-exchange.mjs`, which implements the verified
   weight accounting (3000/min, weight 1 per symbol, 429 + `X-Api-Limit-Reset-Timestamp`).
   The live run attaches to the E11 gate report.
2. **Real lease handoff → E12.** `workers/wrangler.toml` has no DO binding yet, so
   `ExecutionAuthority` is not deployed. Handoff/fencing are proven at module level and
   through the D1 authority row (`health_snapshots.id='lease_authority'`, written by
   `POST /api/lease:handoff` — operator/admin only). **Operational consequence until E12:**
   after any degradation, returning to PRIMARY requires an operator handoff, because
   nothing renews the lease on its own. The E12 DO writes the same row and renews it every
   10s, which removes the manual step.
3. **5s poll cadence → E12.** ADR-004 chooses a 5s poll; the cron fires every 10s and the
   poller's own floor is `POLL_MS`. Observed cadence is therefore 10s until the DO alarm
   lands (E12), which is *slower* than the proven envelope (more margin, not less).
   `tick(nowMs)` takes time as an argument so tests/drills drive an exact 5s cadence.
4. **Detection latency.** §6.1 declares UNHEALTHY after 3 missed 5s beats (15s) and the
   threshold is unchanged; with a 10s cron the observed detection lands ≤ ~25s after the
   last heartbeat. Recorded, not compensated by weakening the rule.
5. **Exchange-side ack-loss (§6.4) → E09.** E06-T02 proves *our* side is duplicate-free
   (intent rows, `evt` dedupe, approval single-use); resolving `SUBMIT_UNKNOWN` against the
   venue is E09's order-by-`client_order_id` poll. The default resolver deliberately
   resolves nothing rather than invent exchange truth.

## 3. Notes found while implementing S3

- `lease.mjs` `release()` used to clear the record, which reset the epoch counter — a
  handoff could hand a zombie holder a *reusable* epoch. It now keeps the counter and
  clears only the holder, and `renew()` reports a superseded epoch as `stale-epoch`
  regardless of holder, so the fencing token is what fails. Covered by `rejoin.test.mjs`.
- The poller's in-flight marker (`poll_quotes.inflight`) doubles as §6.3 condition 3. A
  round that dies mid-flight leaves it at 1, so recovery stays blocked until it is
  resolved — deliberately conservative, and revisited with the DO alarm at E12.
- **`CLIENT UNPAUSE` cannot traverse a paused socket.** During `CLIENT PAUSE` the
  harness's own `UNPAUSE` times out (its connection predates the pause), so the pause's
  `--pause-ms` auto-expiry is what restores Redis; pin it to land within `--recover-ms`.
  A fresh connection *can* unpause immediately, so this is a harness-socket artefact, not
  a defect in the system under test.
- **One fresh DB per drill.** The sweep certifies `reconcile.complete` once per episode
  and only re-certifies after a sweep sees a non-empty inventory; on a reused DB the
  second drill cannot emit its own certify and `rejoin_order` would pair against the
  previous episode's incident. Each drill therefore runs against a freshly seeded DB.
- **The Go pattern must exclude the drill's own argv.** `go run` executes from the
  build cache (`…/Caches/go-build/…/go-watcher`), so `exe/go-watcher` never matches and a
  bare `go-watcher` self-matches (the drill `SIGSTOP`s itself). The `[g]o-watcher`
  character-class form matches only the binary — recorded in `docs/ops/DRILLS.md`.
