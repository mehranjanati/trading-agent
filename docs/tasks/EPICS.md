# Epics E00–E12 (goal · scope · exit · tasks)

| ID | Name | Pri | Goal | Exit gate | Tasks |
|---|---|---|---|---|---|
| E00 | Repository Foundation & Conventions | P0 | Layout, lint, CI, PR workflow | `make check` green; template+CODEOWNERS live | E00-T01 DONE, E00-T02 IN_REVIEW |
| E01 | Config, Secrets & Security Foundation | P0 | Env separation, secret store, RBAC, key policy | Scan clean; no keys; RBAC matrix approved | E01-T01, E01-T02 (5 subtasks) |
| E02 | Toobit Market Data Connector | P1 | Verified WS client + normalizer | 24h soak log; flap clean; URL+date recorded | E02-T01 BLOCKED A-01/A-02, E02-T02 BLOCKED A-01 (6) |
| E03 | Go Price Watcher & Redis State | P1 | Triggers + Streams + staleness | Replay deterministic; restart-safe | E03-T01, E03-T02 (5) |
| E04 | D1 Persistence, Event Log & Outbox | P0 | Canonical schema + outbox relay | Dedupe enforced; RPO-zero; relay redelivers | E04-T01, E04-T02 (5) |
| E05 | Control API & DO Coordination | P1 | CRUD + lease + shards + fanout | Contract tests; split-brain fenced | E05-T01, E05-T02 (5) |
| E06 | Health, Failover & Recovery | P0 | Detect 15s; drills; rejoin | kill-Go/Redis/both green; no 429s | E06-T01, E06-T02 (5) |
| E07 | Signal Ingestion & Strategy | P1 | 5 kinds + versioned config | Schema tests; version pinning | E07-T01 (2) |
| E08 | Risk Engine & Human Approval | P0 | 8 deterministic gates + single-use approvals | 100% reject coverage; race-safe consume | E08-T01, E08-T02 (4) |
| E09 | Order Execution & Reconciliation | P0 | Idempotent submit + reconcile (testnet) | Ack-loss drill; kill <5s; one order/ID | E09-T01 (3) |
| E10 | Dashboard & Audit Timeline | P1 | SvelteKit 11 views + freshness | Degraded-UX test; badge coverage | E10-T01 (3, Q-01 decided) |
| E11 | Testing, Simulation & Paper Trading | P0 | Suites + 14d paper + gate report | Zero unapproved; signed report | E11-T01 (3) |
| E12 | Deployment, Monitoring & Readiness | P1 | Envs, alerts, backups, drills | Rollback <5min; alert routing | E12-T01 (3) |
| E13 | Go/WASM Strategy Runtime (PLAN ONLY) | P0/P1 | Versioned WASM strategies w/o rebuild | Contract frozen; compat matrix; MVP backlog | E13-T01 DONE, E13-T02..T06 (11) |

Total: 27 tasks, 67 subtasks. Source of truth: `BACKLOG.json`.
