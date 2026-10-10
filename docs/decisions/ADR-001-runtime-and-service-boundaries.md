# ADR-001 — Runtime & Service Boundaries

Status: PROPOSED | Date: 2026-10-10

## Context
Need persistent outbound Toobit WS + fast triggers + durable business state + dashboard.

## Decision
Go on Hetzner holds WS + Price Watcher; Redis caches + Streams; Workers/D1/DO own canonical state + coordination; Fiber (if used) only for Go HTTP control API, never the WS client (use nhooyr/gorilla).

## Alternatives
A: Workers-only WS — rejected (no durable outbound socket guarantee). B: Go holds business state — rejected (recovery risk). C: Python watcher — rejected (Go better for long-lived conn + ops simplicity).

## Consequences
+ Clean failure boundaries; − two runtimes to operate.

## Verification
Heartbeat + reconnect tests in E02/E03; review vs Cloudflare docs (URL+date recorded).
