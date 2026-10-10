# ADR-001 — Runtime & Service Boundaries

Status: ACCEPTED (2026-10-10) | Deciders: human + architect | Relates: §02, §03, E02/E03/E05

## Context
We need a persistent outbound connection to Toobit's public market WebSocket (24/7, auto-reconnect), sub-second trigger evaluation, a replayable event buffer, durable business state, and an incident-usable dashboard. No single runtime does all of this well: Workers/DOs must not be assumed to hold long-lived outbound sockets; a VPS-held database is an ops liability.

## Decision
- **Go on a persistent Hetzner host** owns the outbound WS, normalization, in-memory last-price map, trigger evaluation, heartbeats and reconnect with bounded exponential backoff. Its HTTP surface (Fiber or stdlib per Q-02) is ops-only (`/healthz /readyz /watches/cache`).
- **Redis (same host/VPC)** owns fast state: last-price cache, ACTIVE-watch cache, Streams buffer with consumer groups.
- **Cloudflare Workers + D1 + Durable Objects** own canonical state, APIs, orchestration, leases and the dashboard BFF.
- **Fiber, if used, is only the Go HTTP control API** — never the WS client (use `nhooyr.io/websocket` or `gorilla/websocket`).

## Alternatives considered
- A: Workers-only (no Go) — rejected: no durable outbound-WS guarantee; tick fan-in risk; VERIFY_REQUIRED against Cloudflare docs showed no basis for 24/7 socket hold.
- B: Go holds business state (SQLite/Postgres on Hetzner) — rejected: split-brain with D1, backup burden, harder incident UX.
- C: Python watcher — rejected: weaker long-lived-connection ergonomics and higher tail-latency variance for this team's ops profile.

## Consequences
+ Clear failure boundaries (Go/Redis can die without losing business truth). + Independent scaling (add shards/hosts). − Two runtimes to deploy/monitor (mitigated by §12 runbooks).

## Verification
E02 24h soak + flap test; E03 replay determinism; review Cloudflare WS guidance with URL + date recorded in E02-T01 evidence.
