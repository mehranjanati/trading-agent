# 14 — Assumptions, Decisions & Open Questions (living register)

## 14.1 Decided (binding)
- **D-01** Go holds WS + watcher; Redis cache+streams; Workers/D1/DO canonical + coordination (ADR-001/002). 2026-10-10.
- **D-02** Human approval required for every new order initially (SAFE-002). 2026-10-10.
- **D-03** No withdrawal permissions, ever (SAFE-008). 2026-10-10.
- **D-04 Q-01 CLOSED → SvelteKit** for dashboard (lightweight TS, adapter-cloudflare). 2026-10-10, owner human. Unblocks E10-T01.
- **D-05** At-least-once + dedupe + outbox + idempotent submit; no exactly-once claims (ADR-005). 2026-10-10.

## 14.2 Assumptions (VERIFY_REQUIRED — each blocks backlog items)
- **A-01** Toobit public WS channel/shape/limits for USDT-M Futures — verify vs official docs, record URL + access date. Blocks E02-T01/T02.
- **A-02** Toobit REST rate limits + `clientOrderId` support — verify, feed ADR-004 math. Blocks E06-T02/E09-T01.
- **A-03** Cloudflare D1/DO/Workers limits current as of 2026-10-10 — re-verify at E04/E05 start (source URL + date).
- **A-04** Hetzner host baseline 2vCPU/4GB suffices for ≤50 symbols primary — validate in E02 soak, resize per metrics.

## 14.3 Open questions (owner · close-by · options)
- **Q-02** Fiber vs net/http for Go ops API? Owner: implementer · Close: E02 start · Options: Fiber (familiar) / stdlib (fewer deps). Lean stdlib unless benchmarked need.
- **Q-03** Symbol universe + per-symbol weight? Owner: trader · Close: E02-T01 · Needed for fallback math + allowlist (R-SYM).
- **Q-04** Stale thresholds per symbol? Owner: trader · Close: E03 · Proposal: majors 5s, alts 10s.
- **Q-05** Approval expiry default? Owner: trader · Close: E08 · Proposal: 10min.
- **Q-06** Kill-switch + release actors? Owner: human · Close: E08 · Proposal: operator engages, second human releases.
- **Q-07** External signal-system auth (HMAC/JWT/mTLS)? Owner: signal owner · Close: E07 · Proposal: HMAC webhook.
- **Q-08** Hetzner sizing/region/backups? Owner: operator · Close: E12 · Proposal: FSN1, daily snapshots.
- **Q-09** Cloudflare plan limits (D1 rows/writes, DO requests)? Owner: operator · Close: E04 · Verify on dashboard + docs.
- **Q-10** Testnet availability on Toobit? Owner: researcher · Close: E02-T01 · If none, paper-simulator in Workers (E11).
