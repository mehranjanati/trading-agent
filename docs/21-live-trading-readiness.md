# 21 — Live-Trading Readiness (PROPOSED — gate plan, does NOT enable live trading)

**Status:** PLAN ONLY | **Owner:** execution + ops | **Decision record:** [ADR-013](./decisions/ADR-013-live-execution-adapter.md)

This document describes **what must exist before a live order can be placed** and in
which order it is built. It changes no behaviour: today the platform is paper-only
(D-06: Toobit publishes no testnet; the wired adapter is a simulator). Nothing in this
file is a live-enable switch — the switch itself is a config + secrets + sign-off event
(§21.5) and is blocked until every gate in §21.9 is signed.

Related: [08 risk & execution safety](./08-trading-risk-and-execution-safety.md) ·
[12 runbook](./12-deployment-and-operations-runbook.md) ·
[14 decisions](./14-assumptions-decisions-and-open-questions.md) ·
[ops/CONFIG-MATRIX](./ops/CONFIG-MATRIX.md) ·
[ops/TOOBIT-KEY-POLICY](./ops/TOOBIT-KEY-POLICY.md) ·
[ops/TOOBIT-API-FACTS](./ops/TOOBIT-API-FACTS.md) ·
[19 bot runs](./19-bot-runs-single-multi-strategy.md).

## 21.1 Where the venue is selected today

| Layer | File | Today |
|---|---|---|
| Adapter interface | `workers/src/exchange.mjs` | `createPaperExchange()` — deterministic simulator with `loseAck`/`reject`/`fill` knobs for drills |
| Status vocabulary | `workers/src/exchange.mjs` `VENUE_STATUS_MAP` | PENDING_NEW·NEW·PARTIALLY_FILLED·FILLED·CANCELED·PENDING_CANCEL·REJECTED → our FSM; unknown → `null` (never resolves an intent) |
| Submit path | `workers/src/execution.mjs` `submitIntent()` | kill → lease fence → risk gates → consume approval → insert intent → submit → persist |
| Reconcile | `workers/src/reconcile.mjs` + `exchangeResolver` | `query(client_order_id)` is the only source of order truth |
| Health surface | `GET /api/health` → `execution_venue` | the layout prints `paper-sim` vs `injected-adapter` so a simulated fill is never mistaken for a live one |

The execution plane is Cloudflare-only (D-08) and stays that way: the Go watcher
never submits, including in fallback.

## 21.2 The hard safety gate (SAFE-007) — cannot be waived

> ≥14 consecutive days of paper operation with **zero unapproved orders**, zero
> duplicate orders per `client_order_id`, and every non-terminal intent reconciled to
> terminal, before any live discussion.

Machine-checkable evidence, already produced by the repo:

- `node scripts/paper-cycle.mjs` — one full cycle (evidence under `docs/ops/paper/`).
- `node scripts/paper-gate.mjs` — evaluates the 14-day window and writes the report.
- `node scripts/chaos.mjs` — ack-loss / kill / restart drills with written evidence.
- `recovery_log` rows: `kill.engaged`/`kill.released`, `lease.fenced`,
  `order.submit_unknown`, `rate_limit_backoff`, `reconcile.complete`.

## 21.3 Phases (order is binding)

| Phase | Work | Exit criterion |
|---|---|---|
| **P0 — proof** | 14-day paper run; drills green; gate report signed | `paper-gate` report = PASS + signed row in `recovery_log` |
| **P1 — signed adapter** | `workers/src/exchange-live.mjs`: HMAC-signed submit + query by `client_order_id`; selected behind a factory; simulator kept for tests | adapter contract tests pass against recorded fixtures; ack-loss still yields `SUBMIT_UNKNOWN` (never a resubmit) |
| **P2 — env gate** | `ENV=live` + `LIVE_TRADING_ENABLED=true` read in ONE place (the exchange factory); default false; boot refuses when half-configured | a deploy with the flag unset behaves exactly like today; a flag without keys fails closed at boot |
| **P3 — live-only controls** | timestamp/`recvWindow`, position mode, margin mode, funding/liquidation awareness, close-all, key rotation drill | each §21.6 item has an owner + a test; close-all proven < 5s from the kill switch |
| **P4 — first live order** | two-person release: flag flip + key swap + supervised first trade at the smallest allowed notional | first live order reconciled to terminal; kill switch exercised immediately after |

## 21.4 Signed adapter contract (P1, normative)

The adapter keeps the **exact** interface the paper simulator has, so `execution.mjs`,
`reconcile.mjs` and every test keep working unchanged:

```js
// workers/src/exchange.mjs (factory — the only place the venue is chosen)
export function createExchange(env) {
  return env.LIVE_TRADING_ENABLED === "true" && env.ENV === "live"
    ? createLiveExchange(env)   // signed REST, trade-only keys
    : createPaperExchange();    // simulator (default, always safe)
}
```

Required behaviour of `createLiveExchange(env)`:

1. `submit({client_order_id, symbol, side, qty, price, stop_loss})`
   - sign with `TOOBIT_API_KEY`/`TOOBIT_API_SECRET` (HMAC-SHA256, parameter order per
     `docs/ops/TOOBIT-API-FACTS.md`), `recvWindow` from config (default 5000 ms);
   - send `client_order_id` verbatim (`client_order_id = intent_id`, SAFE-004);
   - **5xx / timeout / malformed body → throw `ackLost()`** → `SUBMIT_UNKNOWN` →
     reconcile only (never a blind resubmit, SAFE-005);
   - map the venue vocabulary through `VENUE_STATUS_MAP`; an unknown status returns
     `null` and must not resolve anything (fail closed).
2. `query(client_order_id)` → `{exchange_order_id, venue_status, fills[]}` or `null`.
   A `null` leaves the intent unresolved and keeps the sweep polling.
3. No balances, no withdrawals, no transfer endpoints — trade scope only (SAFE-008).
4. Never log a signature, an API key, or a secret (docs/07 §7.4).

## 21.5 The env gate (P2)

| Var | Paper (today) | Live (gated) | Behaviour |
|---|---|---|---|
| `ENV` | `paper` | `live` | selects the adapter only when BOTH are set |
| `LIVE_TRADING_ENABLED` | *(absent)* | `true` | absent/false = simulator, no exception |
| `TOOBIT_API_KEY` / `TOOBIT_API_SECRET` | absent | secret store only | trade-only keys, IP allowlisted |
| `TOOBIT_RECV_WINDOW` | — | `5000` | clock-skew guard; NTP on the caller |
| `POSITION_MODE` | — | `one-way` \| `hedge` | must match the account, verified at boot |
| `MARGIN_TYPE` | — | `cross` \| `isolated` | verified at boot |

Rules:

- The flag is read in **one** module (the exchange factory). No other code branches on it.
- Half-configuration (`ENV=live` without keys, flag without `ENV=live`) is a **boot
  failure**, not a degraded mode — a live-capable but misconfigured process must never
  start.
- `GET /api/health.execution_venue` must report `toobit-live` so the dashboard banner
  can never show a live fill as paper (and vice versa).

**Existing tripwires the flip must go through (do not remove them, adapt them):**

- `scripts/paper-gate.mjs` refuses a PASS when **any** `LIVE_*` env key exists
  (`liveSmell` check, SAFE-007) — this is the smell test that catches an accidental
  live enable in CI.
- `scripts/paper-cycle.mjs` and `scripts/chaos.mjs` both refuse to run when
  `LIVE_TRADING_ENABLED` is set (their drills must never touch a live venue).

Consequence: flipping the flag is not enough — the release PR must **deliberately**
update these guards (and their tests `paper-gate.test.mjs`, `chaos.test.mjs`) with a
signed gate report attached. A PR that sets the flag while the guards still fire will
break `make check`, which is the intended failure.

## 21.6 Live-only gaps (must be closed in P3)

| Gap | Why it matters live | Where it lands |
|---|---|---|
| HMAC signer + clock sync | a skewed timestamp is a silent `REJECTED` on every order | `workers/src/exchange-live.mjs`, ops NTP check |
| Position mode / margin mode | the venue rejects, or flips intent semantics, when the account disagrees | boot check + config version |
| Funding rate + liquidation price | a held position can be liquidated with no signal in the UI | position read path + dashboard column |
| Close-all (emergency flatten) | the kill switch stops *new* orders; it does not flatten exposure | `workers/src/kill.mjs` extension + drill |
| Order-type coverage | market-only is fine for MVP; limit/stop need explicit gates | adapter + risk-gate note |
| Partial fills → position math | handled for paper (`positionStatements`), must be re-proven live | reconcile tests on recorded fixtures |
| Key rotation dry-run | the 90-day policy (TOOBIT-KEY-POLICY §5) is untested live | runbook §12.5 drill |

## 21.7 Secrets & key policy

- `wrangler secret put TOOBIT_API_KEY` / `TOOBIT_API_SECRET` — never in git, never in
  the dashboard, never in chat (docs/07, `docs/ops/SECRET-STORE.md`).
- **Withdrawals disabled at the exchange.** Any withdrawal-scoped code is a P0 defect.
- IP allowlist = the Workers egress (Cloudflare) — not a laptop, not the Go host.
- Rotation every 90 days: create → dual-run reconcile → revoke → `recovery_log` row.

## 21.8 Rollback (must be provable, < 5 minutes)

1. `POST /api/kill-switch {engaged:true, reason}` — new orders stop (< 5 s, SAFE-006).
2. Flatten exposure with close-all (P3) or manually at the venue.
3. Flip `LIVE_TRADING_ENABLED` to `false` and redeploy → the simulator is the adapter again.
4. Revoke the keys at the venue; write one `recovery_log` row naming actor + reason.
5. Reconcile every non-terminal intent to terminal before any restart
   (`SUBMIT_UNKNOWN` is resolved by `client_order_id`, never by resubmission).

## 21.9 Release gates (all must be true)

- [ ] 14-day paper window PASS (`scripts/paper-gate.mjs`) + signed `recovery_log` row.
- [ ] Zero unapproved orders, zero duplicate `client_order_id`, zero unresolved intents > 5 min.
- [ ] Kill switch engaged → no order, verified in the live configuration (< 5 s).
- [ ] Ack-loss drill repeated against the live adapter (still `SUBMIT_UNKNOWN`, no resubmit).
- [ ] Every risk gate still in the fixed order with fail-closed semantics (docs/08 §8.2).
- [ ] Security review signed: no withdrawal scope, secrets only in the store, no key in logs.
- [ ] Two-person release recorded (SAFE-010 separation of duties).
- [ ] Rollback drill (§21.8) executed once, timed, and logged.

## 21.10 What must NOT change when live lands

- The **risk gate order** and fail-closed semantics (`risk.mjs`) — no bypass, no new
  "skip in live" branch.
- **Single-use, expiring human approval** per order (SAFE-002).
- `client_order_id = intent_id` and the UNIQUE constraint (SAFE-004).
- Positions derived from **fills only** (FR-010).
- D-08: the dashboard never submits; the Go watcher never submits.
- `aggregate.confidence` is never presented as a win probability (SAFE-009).

## 21.11 Explicit non-effect

Merging this document changes nothing at runtime. As of today the wired adapter is
`createPaperExchange()` and `LIVE_TRADING_ENABLED` does not exist in `wrangler.toml`;
adding it without the P0 gate signed off is a review-blocking defect (docs/13 §13.5).
