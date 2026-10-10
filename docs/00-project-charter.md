# 00 — Project Charter: Independent AI Trading Agent (Toobit USDT-M Futures)

**Status:** APPROVED (human, 2026-10-10 — Q-01 decided SvelteKit) | **Owner:** Human approver | **Author:** Muse Spark 1.3

## 1. Vision
Build a reliable, observable, recoverable and secure futures-trading assistant — not a script that submits orders. Every decision in this repo must answer: *what happens when this component fails at 3am with an open position?* If the answer is "unknown", the design is incomplete.

## 2. Goals (G-01..G-08)
- G-01 Reliable Watch→signal→analysis→approval→order→reconcile loop with an audit row for every transition.
- G-02 Full observability: health, freshness, latency, error budgets and audit timelines.
- G-03 Safe failover between primary (Go+Redis on Hetzner) and fallback (Workers/DO/D1 + rate-limited REST).
- G-04 Human approval before every new order in the initial operating mode.
- G-05 Deterministic risk enforcement fully independent of AI output.
- G-06 Independently deployable repository; no merge into any SaaS or EdgeTune project.
- G-07 Paper-trading proof (≥14 days, zero unapproved orders) before any live-trading conversation.
- G-08 Dashboard remains useful during incidents and always labels data LIVE / STALE / CACHED / UNAVAILABLE.

## 3. Scope (in)
- Toobit USDT-M Futures public market-data WebSocket connector (Go) with reconnect, normalization and staleness detection.
- Price Watcher with trigger/invalidation evaluation and Redis Streams event buffer.
- Cloudflare control plane: Workers APIs, D1 canonical state, Durable Object coordination/leases.
- Signal ingestion: triple divergence, institutional order blocks, overbought/oversold, multi-timeframe confirmation, market regime and invalidation conditions.
- AI analysis orchestration (advisory only), human approval workflow, deterministic risk engine.
- Order execution state machine with idempotent submit and exchange reconciliation (test-gated).
- SvelteKit operations dashboard (decided Q-01, 2026-10-10) with health, audit and degraded-mode UX.
- Deployment, monitoring, backup, rollback and incident runbooks.

## 4. Non-goals (explicit)
- NG-01 No live trading without an explicit, signed human release gate (see `tasks/TEST-AND-RELEASE-GATES.md`).
- NG-02 No withdrawal permissions in any API key, ever.
- NG-03 No guaranteed-profitability claims from backtests or simulations.
- NG-04 No tick-by-tick price storage in D1.
- NG-05 No auto-trading flag in MVP; any such proposal needs a new ADR plus human approval.
- NG-06 No merge into unrelated SaaS/EdgeTune codebases.

## 5. Actors & responsibilities
| Actor | Responsibility | Cannot do |
|---|---|---|
| Human Trader | Creates Watches, approves/rejects orders, owns live-trading gate | Bypass audit log |
| Operator | Deploys, monitors, runs drills, executes runbooks | Approve own orders (SoD) |
| Risk Engine | Deterministic pre-order gates (code, not model) | Be overridden by AI output |
| AI Analyst | Advisory rationale + confidence + invalidation refs | Emit orders, override risk |
| Go Watcher | Market-data intake, trigger evaluation, heartbeat | Hold canonical business state |
| Exchange (Toobit) | Market data source, order venue | Be trusted blindly (reconcile) |

## 6. Initial operating mode
`HUMAN_APPROVAL_REQUIRED=true` (hard default). Every new order needs a single-use, expiring human approval. Fail closed on any uncertainty in price freshness, approval validity, durable state or order outcome (SAFE-001). Paper/testnet only until the release gate passes.

## 7. Success criteria (measurable)
- S-01 Paper-trade loop runs 14 days with zero unapproved orders and a filed gate report.
- S-02 Failover drill (Go loss, Redis loss, both) recovers Watches from D1 with zero duplicate order intents.
- S-03 Dashboard labels data freshness correctly in 100% of sampled incident minutes.
- S-04 All P0 gates in `tasks/TEST-AND-RELEASE-GATES.md` pass with evidence links.
- S-05 `make check` (lint + backlog validation + secret scan) green on every commit to main.

## 8. Constraints, risks & links
- Safety requirements: `08-trading-risk-and-execution-safety.md` (SAFE-001..SAFE-008).
- Functional/non-functional requirements: `01-product-requirements.md` (FR-/NFR-).
- Architecture: `02-system-architecture.md`; decisions: `decisions/ADR-001..005`.
- Top risks: unverified Toobit API limits (A-01/A-02, VERIFY_REQUIRED), single persistent WS host, REST-fallback adequacy unproven until ADR-004 math is done.
- Related: [Requirements](./01-product-requirements.md) · [Architecture](./02-system-architecture.md) · [Roadmap](./tasks/ROADMAP.md) · [Open questions](./14-assumptions-decisions-and-open-questions.md).
