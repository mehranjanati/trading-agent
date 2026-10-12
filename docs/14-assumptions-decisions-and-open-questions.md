# 14 — Assumptions, Decisions & Open Questions (living register)

## 14.1 Decided (binding)
- **D-01** Go holds WS + watcher; Redis cache+streams; Workers/D1/DO canonical + coordination (ADR-001/002). 2026-10-10.
- **D-02** Human approval required for every new order initially (SAFE-002). 2026-10-10.
- **D-03** No withdrawal permissions, ever (SAFE-008). 2026-10-10.
- **D-04 Q-01 CLOSED → SvelteKit** for dashboard (lightweight TS, adapter-cloudflare). 2026-10-10, owner human. Unblocks E10-T01.
- **D-05** At-least-once + dedupe + outbox + idempotent submit; no exactly-once claims (ADR-005). 2026-10-10.
- **D-06 Q-10 CLOSED → no Toobit testnet found in official docs (2026-10-10).** E09/E11 use a Workers paper-simulator until a testnet is confirmed. Owner: researcher. Unblocks E09-T01 design.
- **D-07 ADR-004 ACCEPTED** — fallback 5s REST poll proven for ≤100 symbols (3000 weight/min ÷ weight-1 ticker). Owner: architect.
- **D-08 Execution plane is Cloudflare-only** — signed submit + reconcile run in Workers; orders, positions and approvals are canonical in D1; dashboard is read-only via Workers. Go Watcher is market-data + triggers only and MUST NOT submit orders, including fallback (docs/03 §3.3, ADR-003). Toobit trade keys live in the Cloudflare secret store only (T5). 2026-10-11. Owner: architect.

## 14.2 Assumptions (VERIFY_REQUIRED — each blocks backlog items)
- **A-01 CLOSED 2026-10-10** — WS verified: `wss://stream.toobit.com/quote/ws/v1`, topics trade/markPrice/bookTicker, ping ≤5min, symbol form `BTC-SWAP-USDT`. Evidence: `docs/ops/TOOBIT-API-FACTS.md`. Unblocked E02-T02.
- **A-02 CLOSED 2026-10-10** — REST verified: base `https://api.toobit.com`, 3000 weight/min + 60 orders/2s, `clientOrderId` supported, recvWindow default 5000. Evidence: same file. Unblocked E06-T02/E09-T01 math.
- **A-03** Cloudflare D1/DO/Workers limits current as of 2026-10-10 — re-verify at E04/E05 start (source URL + date).
- **A-04** Hetzner host baseline 2vCPU/4GB suffices for ≤50 symbols primary — validate in E02 soak, resize per metrics.

## 14.3 Open questions (owner · close-by · options)
- **Q-02** Fiber vs net/http for Go ops API? Owner: implementer · Close: E02 start · Options: Fiber (familiar) / stdlib (fewer deps). Lean stdlib unless benchmarked need.
- **Q-03** Symbol universe + per-symbol weight? Owner: trader · Close: E02-T01 · Needed for fallback math + allowlist (R-SYM).
- **Q-04** Stale thresholds per symbol? Owner: trader · Close: E03 · Proposal: majors 5s, alts 10s.
- **Q-05 CLOSED (E08-T02, 2026-10-12)** — approval expiry default 10m, sourced from the active `strategy_configs.approval_ttl_s` (seed 600); expiring approvals are swept by a 60s cron with idempotent `approval.expired_v1` audit events.
- **Q-06** Kill-switch + release actors? Owner: human · Close: E08 · Proposal: operator engages, second human releases.
- **Q-07 CLOSED (E07-T01, 2026-10-12)** — External signal auth = **HMAC-SHA256 webhook** (`X-Signal-Source/-Timestamp/-Nonce/-Signature`), constant-time compare, nonce replay guard, 30s clock-skew reject (docs/07 §7.4). Provenance is an authenticated source identity + a config-driven per-kind allowlist; it proves source identity only and never strategy validity (E08 R-gates decide). Secrets via `SIGNAL_HMAC_SECRET`/`SIGNAL_HMAC_SECRETS`.
- **Q-08** Hetzner sizing/region/backups? Owner: operator · Close: E12 · Proposal: FSN1, daily snapshots.
- **Q-09** Cloudflare plan limits (D1 rows/writes, DO requests)? Owner: operator · Close: E04 · Verify on dashboard + docs.
- **Q-10 CLOSED → no testnet** (D-06 above). E09/E11 use paper-simulator.
- **Q-11** wazero version vs go1.23 + wasip1 stdlib coverage? Owner: implementer · Close: E13-T03 · Needed for ADR-006 verification (URL+date).
- **Q-12** Artifact store location/quota (Hetzner vol path + backup)? Owner: operator · Close: E13-T04 · Proposal: volume dir + hourly snapshot.
- **Q-13** WASM invocation budget SLO (p95 ms, mem MB)? Owner: trader+operator · Close: E13-T03 bench · Proposal: 500ms deadline, measure first.
- **Q-14** `WASM_PROPOSAL` signal kind + RBAC for activation? Owner: signal owner+admin · Close: E13-T02 · Proposal: kind added, admin-only activation.
