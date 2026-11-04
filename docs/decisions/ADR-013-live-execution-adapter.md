# ADR-013 — Live execution: a signed adapter behind a fail-closed env gate

Status: PROPOSED 2026-11-01 (requires human sign-off; enables nothing by itself) | Relates: docs/08 §8.1 (SAFE-007/008), docs/21, docs/ops/TOOBIT-KEY-POLICY, D-06, D-08

## Context
The execution plane is complete and paper-only: `workers/src/execution.mjs`
performs kill → lease fence → risk gates → consume approval → intent → submit →
persist, and `workers/src/exchange.mjs` injects a deterministic **paper simulator**
because Toobit publishes no testnet (D-06). Every downstream guarantee (reconcile
by `client_order_id`, `SUBMIT_UNKNOWN`, positions from fills) is written against
that adapter *interface*, not against a live venue.

There is therefore no code gap in the control path — the gap is the **adapter** and
the **permission to use it**. Shipping a live adapter without an explicit, single,
fail-closed switch (and without the SAFE-007 paper proof) would make "which venue
did this fill come from?" a question the codebase cannot answer.

Docs/13 §13.5 already forbids adding live-enable flags without an ADR and human
sign-off; this ADR is that record.

## Decision
1. **Interface preserved.** The live adapter implements the same
   `submit()` / `query()` contract as `createPaperExchange()`, so `execution.mjs`,
   `reconcile.mjs`, and their tests are untouched. `VENUE_STATUS_MAP` stays the
   only status translation; an unknown venue status still resolves nothing.
2. **One selection point.** A single factory chooses the adapter:

   ```js
   env.LIVE_TRADING_ENABLED === "true" && env.ENV === "live"
     ? createLiveExchange(env)   // signed REST, trade-only keys
     : createPaperExchange();    // default, always safe
   ```

   No other module branches on the flag.
3. **Fail closed at boot.** `ENV=live` without keys, or the flag without
   `ENV=live`, is a startup failure — a half-configured live process must not run.
   An absent flag means the simulator, with no exception path.
4. **Ack-lost is not a failure.** 5xx/timeout/malformed body → `ackLost()` →
   `SUBMIT_UNKNOWN` → reconcile by `client_order_id`. A blind resubmit stays
   forbidden (SAFE-005).
5. **Trade-scope only.** No withdrawals, no transfers, no balance mutation
   endpoints in the adapter (SAFE-008); keys are IP-allowlisted and rotated per
   `docs/ops/TOOBIT-KEY-POLICY`.
6. **Truth in the UI.** `GET /api/health.execution_venue` reports `toobit-live`, so
   the layout banner can never show a live fill as paper or the reverse.
7. **Gated release.** Live is reachable only after the docs/21 §21.9 gates are
   signed: 14-day paper PASS (SAFE-007), ack-loss drill against the live adapter,
   kill-switch proof (<5s), security review, two-person release (SAFE-010), and a
   timed rollback drill.

## Alternatives
- **A — auto-enable live when keys are present**: rejected; the presence of a key
  is not a decision, and a leaked/stale secret would arm the venue silently.
- **B — separate live worker/service**: rejected; the execution plane is
  Cloudflare-only by D-08, and a second submit path doubles the audit surface.
- **C — wait for a Toobit testnet**: rejected as the only option; it has not
  existed since 2026-10-10 (D-06) and blocks the whole gate. Paper + recorded
  fixtures + the drills are the substitute proof, and they stay mandatory.
- **D — flip the flag with the gates open**: rejected for cause; the gates exist
  because the failure modes (duplicate order, unapproved order, orphaned intent)
  are exactly what the paper window measures.

## Consequences
- Going live is a **config + secrets + two-person sign-off** event, not a code
  branch — the same binary/source that runs paper runs live.
- The repo's existing tripwires keep working until the release PR deliberately
  updates them: `paper-gate.mjs` refuses a PASS when any `LIVE_*` key exists, and
  `paper-cycle.mjs` / `chaos.mjs` refuse to run with `LIVE_TRADING_ENABLED` set.
  A flag flip without that reviewed change fails `make check` on purpose.
- Rollback is symmetric and fast: kill switch → flatten → flag off + redeploy →
  revoke keys → reconcile (docs/21 §21.8, <5 min).
- The dashboard keeps its read-only charter; no live-only UI write path appears.
- A live-only capability (close-all, funding/liquidation awareness, position
  mode) is explicitly tracked as P3 work in docs/21 §21.6 — not smuggled in with
  the adapter.

## Verification
- `node --test workers/src/execution.test.mjs workers/src/reconcile.test.mjs` —
  unchanged against the live adapter's contract fixtures, plus an ack-loss case
  that must produce `SUBMIT_UNKNOWN` and resolve only through `query()`.
- Boot test: flag without `ENV=live` and `ENV=live` without keys both refuse to
  start; flag absent behaves exactly like today.
- Release checklist: docs/21 §21.9, signed, with the `recovery_log` rows attached.
