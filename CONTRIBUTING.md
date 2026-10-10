# Contributing — AI Trading Agent

## Branches
- `main` — protected, paper-only, all CI green + human review.
- `feat/<EPIC>-<short>` e.g. `feat/E01-secrets`, `fix/E04-outbox-retry`.
- Never push directly to `main`.

## Commits
- Prefix with task ID: `E01-T01: add secret-store docs`.
- Small, reviewable, one task per PR.
- Never commit `.env`, keys, or `*.pem`.

## PR workflow
1. Fill template (risk label mandatory).
2. `make check` must be green (CI enforces).
3. `risk:high-safety` needs human reviewer + safety checklist.
4. Squash-merge with task-ID message.

## Safety rules (non-negotiable)
- No live orders, no live keys, no withdrawals.
- No auto-trade flag without ADR + human gate.
- AI output never overrides risk limits.
