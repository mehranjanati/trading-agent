# 14 — Assumptions, Decisions & Open Questions

## Verified decisions
- D-01 Go primary WS holder; D1 canonical; Redis cache (ADR-001/002). D-02 Human approval required initially. D-03 No withdrawals.

## Assumptions (VERIFY_REQUIRED)
- A-01 Toobit public WS channel/limits — verify vs official docs, record URL+date (blocks E02).
- A-02 Toobit REST rate limits for fallback math (blocks ADR-004).
- A-03 Cloudflare D1/DO limits current as of 2026-10-10 — re-verify at implementation.

## Open questions (Q-01..)
- Q-01 Frontend: **DECIDED 2026-10-10 → SvelteKit** (lightweight TS, adapter-cloudflare, small incident-time bundle). Owner: human. Unblocks E10-T01.
- Q-02 Fiber for Go HTTP? Justify vs net/http. Q-03 Symbol universe size? (needed for fallback math). Q-04 Stale thresholds per symbol? Q-05 Approval expiry default? (prop. 10m). Q-06 Kill-switch actors? Q-07 Signal-system auth shape? Q-08 Hetzner sizing? Q-09 Cloudflare plan limits?
