# 11 — Testing & Validation Strategy (pyramid + drills + paper gate)

## 11.1 Levels & ownership
- **Unit** (per-PR, cov ≥80% on safety paths): FSM guards (§05), risk matrix (all R-* codes), dedupe, lease epoch logic, approval single-use.
- **Integration:** Go→Redis→Workers→D1 happy path with fakes; outbox relay; reconcile against Toobit sandbox mock.
- **Contract:** event JSON-schema validation, API snapshot tests, D1 migration up/down on scratch DB.
- **Replay:** recorded tick fixtures → deterministic trigger sequences (golden files in `go-watcher/testdata/`).
- **Load:** 2× target symbols, WS flap (kill -9 loop), Redis eviction, stream-lag SLO check.
- **Security:** authz matrix test, secret-scan (CI), `npm audit`/`go vet`, approval-replay attack test.
- **Recovery (E06-T02):** kill-Go, kill-Redis, kill-both, D1-outage, ack-loss — each asserts zero duplicate intents + audit rows + correct badges.
- **Paper-trading (E11-T01):** ≥14 days on testnet with approvals; nightly gate report (unapproved count must be 0).

## 11.2 Fixtures & doubles
`schemas/*.schema.json` for events; Toobit WS/REST fakes in `workers/test/` + `go-watcher/testdata/`; chaos script `scripts/chaos.sh` (E06).

## 11.3 Entry/exit per epic
E02 exit: 24h soak log. E04: restart-safe proof. E06: drill videos/logs. E08: reject-matrix green. E09: ack-loss drill green on testnet. E11: signed gate report.
