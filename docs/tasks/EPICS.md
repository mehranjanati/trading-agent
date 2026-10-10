# Epics E00–E12

| ID | Name | Priority | Goal | Exit |
|---|---|---|---|---|
| E00 | Repository Foundation & Conventions | P0 | layout, lint, CI, migrations harness | green CI on docs+empty modules |
| E01 | Config, Secrets & Security Foundation | P0 | env separation, secret store, RBAC | secret-scan clean, no keys in repo |
| E02 | Toobit Market Data Connector | P1 | verified WS client + normalize | 24h soak, reconnect test |
| E03 | Go Price Watcher & Redis State | P1 | triggers + streams + heartbeat | replay + lag tests |
| E04 | D1 Persistence, Event Log & Outbox | P0 | canonical schema + outbox relay | restart-safe, RPO-zero |
| E05 | Control API & DO Coordination | P1 | CRUD + sharded coordinators | contract tests |
| E06 | Health, Failover & Recovery | P0 | leases, fencing, drills | kill-Go/Redis/both green |
| E07 | Signal Ingestion & Strategy | P1 | 5 signal kinds + versioned config | schema tests |
| E08 | Risk Engine & Human Approval | P0 | deterministic gates + approval | 100% reject-path coverage |
| E09 | Order Execution & Reconciliation | P0 | idempotent submit + reconcile | ack-loss drill, testnet only |
| E10 | Dashboard & Audit Timeline | P1 | 11 views + freshness badges | degraded-UX test |
| E11 | Testing, Simulation & Paper Trading | P0 | suites + 14d paper | gate report |
| E12 | Deployment, Monitoring & Readiness | P1 | envs, runbooks, alerts | incident drill |
