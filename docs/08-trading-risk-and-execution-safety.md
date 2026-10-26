# 08 — Trading Risk & Execution Safety (normative — overrides all other docs on conflict)

## 8.1 Safety requirements (SAFE-001..SAFE-010)
- **SAFE-001 Fail closed:** uncertain price freshness, approval validity, durable state or order outcome → no new order, record reason, alert.
- **SAFE-002 Human approval:** every new order in initial mode needs single-use, expiring (10m default, Q-05) human approval. No batch pre-approvals.
- **SAFE-003 Deterministic gates:** risk runs in code with fixed limits; AI output is advisory input only and can never widen limits.
- **SAFE-004 Idempotency:** `client_order_id = intent_id`; retries reuse it; duplicates rejected by UNIQUE constraint.
- **SAFE-005 Reconcile-to-terminal:** every intent reaches `FILLED|REJECTED|CANCELLED|EXPIRED` via exchange truth; `SUBMIT_UNKNOWN` reconciles only.
- **SAFE-006 Kill switch:** halts new orders <5s, logs actor+reason, survives restarts (persisted flag).
- **SAFE-007 Paper/testnet proof:** ≥14-day paper run with zero unapproved orders before any live discussion.
- **SAFE-008 No withdrawals:** trade-only keys; any withdrawal-scoped code is a P0 defect.
- **SAFE-009 No profit guarantees:** backtests are not evidence of future returns; never displayed as such.
- **SAFE-010 Separation of duties:** approver ≠ risk-config editor for the same order path.

## 8.2 Risk gate table (codes are user-visible)
| Code | Gate | Default | On reject |
|---|---|---|---|
| R-KILL | kill switch off | off=pass | halt + `kill.engaged` |
| R-APPROVAL | approval valid+unused+unexpired | strict | 410/403 with reason |
| R-SYM | symbol allowlisted | BTC/ETH/SOL allowlist (Q-03 sizes) | reject + suggest |
| R-LEV | leverage ≤ max | 5x | reject with limit/asked |
| R-NOT | notional ≤ max | $1,000/intent (tunable, Q) | reject |
| R-EXP | total exposure ≤ cap | $5,000 | reject |
| R-SLOT | concurrent ACTIVE watches ≤ cap | 10 portfolio / 3 per symbol (v2-paper) | reject |
| R-STALE | price age ≤ threshold | 5s | HOLD + refresh |
| R-DUP | no live intent for same approval | strict | 409 |
Limits live in versioned `strategy_configs`; changes need the **admin** role + audit row (RBAC matrix; SAFE-010 separation of duties).

**Gate semantics (E08-T01, normative):**
1. Gates run in the table order above and the **first failure wins** — a reject is deterministic and reproducible.
2. **Every gate fails closed** (SAFE-001): a missing/unknown input — kill state, approval, symbol, price, open exposure, duplicate state — is a reject, never a pass. An unknown kill state is treated as engaged.
3. Notional and exposure arithmetic is **exact decimal (string) math**, never floats — a boundary like `0.1 × 0.7 = 0.07` must pass exactly.
4. Limits are the active `strategy_configs` version (E07-T01 pinning); every verdict echoes `limits_version` for audit, and a config missing any bound is a `DEGRADED` system fault — no invented defaults (SAFE-003).
5. Gate carries: `R-LEV`/`R-NOT`/`R-EXP` include `limit` + `asked` (J3); `R-SYM` includes the permitted set; `R-STALE` includes `action: "HOLD"`; `R-SLOT` includes `limit` + `active` (+ `symbol` for the per-symbol bound).
6. Rejections surface as `422 RISK_REJECT {risk_code}` (docs/10); the E09 submit path must call this validator — no other gate implementation is allowed.

### 8.2a Market-regime veto (pre-analysis, per-watch opt-in)
`watches.regime_filter` (migration 0010) makes the regime gate a per-position choice: a BTC scalp may sit out of it while an alt swing opts in. When the flag is `1`, `analyzeWatch` evaluates the four reference indices **before** it asks the Go engine, so a hostile regime cannot be bypassed by an engine outage (it is the one gate that must survive a DEGRADED window).

| Index | Feed | Trend rule |
|---|---|---|
| ETHBTC | OKX `ETH-BTC` → Binance `ETHBTC`; CoinGecko ETH/BTC ratio fallback (Toobit futures lists no ETHBTC contract) | close vs EMA-50 |
| BTC.D · USDT.D · TOTAL3 | CoinGecko top-250 markets, supply-weighted 7-day hourly sparkline (labelled estimate) | close vs EMA-50 |

The run records which provider answered each index in `regime.detail.sources` (`exchange-klines` for the venue pair, `coingecko-estimate` for the supply-weighted approximation), so a measured series is never confused with an estimate.

The regime is the majority trend of the available indices; every index missing is `UNKNOWN`. Each index is classified independently and the majority rule is applied over the indices that answered. A short/missing series is `UNKNOWN` — never interpolated.

**Default veto table** (`DEFAULT_REGIME_CONFIG`; a missing or partial `regime` block in the active `strategy_configs` resolves to this table, never to an empty one — opting in must not fail open):

| Direction | Vetoed regimes |
|---|---|
| altcoin LONG | `BEARISH`, `UNKNOWN` |
| altcoin SHORT | `BULLISH`, `UNKNOWN` |
| BTC LONG / SHORT | `UNKNOWN` |

**Actions (normative):**
1. `VETO` + `action_on_veto=BLOCK` (default): the analysis run is stored as `bias=FLAT, confidence=0, model="regime-filter", engine=null` and the engine is **not** called. This is the only fabricated-by-policy run: the reason is explicit and the index trend is stored in `output_json.regime`.
2. `WARN` (regime `CHOP` or `UNKNOWN`), or `VETO` with `action_on_veto=WARN`: the engine bias is kept and confidence is multiplied by `(1 − confidence_penalty)` (default `0.3`). A veto downgraded to WARN still costs confidence — never a full-confidence trade.
3. Any feed failure (timeout, non-2xx, unusable/short series) becomes `UNKNOWN` → `VETO` for altcoins (SAFE-001). There is no local price invention.
4. An explicit empty list (`veto_altcoin_long: []`) disables that edge; the operator's config version is pinned on the run (`strategy_version`), so the override is auditable.
5. The veto is advisory to execution: it shapes the analysis a human approves against and never submits/cancels an order (SAFE-002, D-08).

## 8.3 Approval workflow (states)
`requested → notified → granted|rejected → consumed|expired` — the request/notify phase **is** the analysis run (no separate row); the approval row appears at the human decision. **Grant** writes the row plus its `approval.granted_v1|rejected_v1` audit event in one batch and returns the token `{approval_id, watch_id, expires_at}`; the TTL is the active `strategy_configs.approval_ttl_s` (10m default, Q-05). **Consume** (invoked by the E09 submit path) is single-flight by construction: the UNIQUE `approval.consumed_v1:<approval_id>` event is the first statement of the batch, so exactly one caller wins and the loser hits the UNIQUE constraint → surfaced `409`; `used_at` is set only for the winner, and a confirm-read fails closed if the row was already consumed. Verdicts carry HTTP status: `200 consumed · 403 not-granted/rejected · 409 already-consumed · 410 expired` — an unreadable `expires_at` counts as expired (fail closed, SAFE-001). State is **derived** from the row (`used_at`, `decision`, `expires_at`), never stored separately, so a stale row cannot disagree with itself; a separate nonce column was deliberately not added because the PK-guarded single-use event already provides that guarantee (docs/04 keeps stamps additive). The 60s sweeper emits `approval.expired_v1:<id>` at most once per approval (idempotent).

## 8.4 Unknown-outcome & duplicate prevention
Timeout/no-response → `SUBMIT_UNKNOWN` → reconcile by `client_order_id` → terminal. Same approval can never mint two intents (UNIQUE on `approval_id` in intents where status != RISK_REJECTED). Same intent can never hit the exchange twice (client ID dedupe + lease epoch).

## 8.5 Kill switch & exposure caps
`POST /api/kill-switch {engaged, reason}` (operator+). Engaged persists in D1 + DO mirror; all submit paths check first. Release needs second human confirm + reason.

**Implemented (E09-T01, `workers/src/kill.mjs`):** the flag is a fixed-id D1 row read fresh on every submit — a restart cannot silently clear a halt, and the halt is a single indexed read (the <5s requirement is asserted in tests, not assumed). Engage writes the row + `kill.engaged_v1` event + a `kill.engaged` incident with actor and reason; release requires **admin** AND an explicit `confirm: true` (two-person rule enforced in code, RBAC matrix) and writes `kill.released_v1` + a `kill.released` incident. A read failure is surfaced to the gate as `engaged: "unknown"`, which risk.mjs treats as engaged (fail closed).

## 8.6 Portfolio slot cap (`R-SLOT`) & protective stop
**Slot cap (E09-T01c, docs/19 §19.7 gap 1).** `R-NOT`/`R-EXP` cap *money*, not *concurrency*: a bot could arm unlimited ACTIVE watches and blow every slot at once. `R-SLOT` caps the number of concurrent `ACTIVE` watches, portfolio-wide (`max_active_watches`) and per symbol (`max_active_watches_per_symbol`). Both bounds are **optional config**: absent → the gate is skipped (no invented limit); present → the cap applies. Only `status='ACTIVE'` watches occupy a slot (`DRAFT`/`TRIGGERED`/`INVALIDATED`/`EXPIRED`/`CLOSED` do not). The counts are read from D1 by the submit path itself (`activeWatchCounts`); a failed or unreadable count is **unknown → reject** (SAFE-001), never a pass. The bounds ship in the `v2-paper` config version (migration `0009_slot_cap.sql`); `strategy_configs` rows are immutable, so a new version — never an edit of `v1-paper` — carries the change, keeping every verdict auditable against the version that judged it.

**Protective stop (`stop_loss`, advisory).** `POST /api/orders:intents` accepts an OPTIONAL decimal `stop_loss`. It is validated by the risk gate (a LONG stop must be strictly below the entry price, a SHORT stop strictly above; anything else is `R-NOT`) and stored on `order_intents.stop_loss` (migration `0008_stop_loss.sql`) and passed to the venue. Storing a stop does **not** place an exit order: a watcher/executor reads the column and submits the exit separately. Absent → the column stays `NULL` — a stop is never invented.
