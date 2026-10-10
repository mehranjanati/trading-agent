# 00 — Repository Audit (Phase 0 Baseline)

**Date:** 2026-10-10 | **Status:** VERIFIED | **Scope:** `/` (workspace root)

## 1. Repository summary
- Workspace path contains **zero files** prior to this task (verified via `ls -la` and `find -maxdepth 4`).
- No README, no manifests, no source, no CI, no deployment config, no secrets detected.
- Conclusion: **greenfield repository**. All documentation in `docs/` is newly authored, not replacing prior work.

## 2. Existing implementation and documentation
- None. No language, framework, or convention to preserve yet.
- No user modifications to preserve. No history to migrate.

## 3. Technology inventory
| Layer | Baseline (per brief) | Found in repo |
|---|---|---|
| Market data / Watcher | Go + Fiber (HTTP control only) on Hetzner | NOT PRESENT |
| Fast state / events | Redis + Redis Streams | NOT PRESENT |
| Control plane | Cloudflare Workers, D1, Durable Objects | NOT PRESENT |
| Dashboard | SvelteKit / lightweight TS on Cloudflare | NOT PRESENT |
| Exchange | Toobit USDT-M Futures | No code, no keys found |

## 4. Current development status
- Stage: **pre-Phase-0 → Phase-1 documentation starting**.
- No build, test, or deploy pipeline exists.

## 5. Existing strengths to retain
- Clean slate: no tech debt, no contradictory configs.
- Opportunity to enforce conventions from day one (see `docs/13-development-guide.md`).

## 6. Contradictions and technical risks
- No contradictions (nothing to contradict). Risks are prospective:
  - R1: Fiber confusion — must not use Fiber as outbound WS client (see ADR-001).
  - R2: Treating D1 as tick DB or DO as WS replacement — explicitly forbidden.
  - R3: REST-poll fallback adequacy UNPROVEN — needs math in ADR-004.
  - R4: Toobit API capabilities unverified — all limits marked VERIFY_REQUIRED until tested.

## 7. Missing requirements
- All implementation, all tests, all CI/CD, all secrets handling, all Toobit verification tasks (captured in `docs/tasks/BACKLOG.json`).

## 8. Assumptions requiring verification
| ID | Assumption | Verification task |
|---|---|---|
| A-AUD-01 | Toobit exposes public WS for USDT-M Futures mark/last price | E02 research + capture URL/date |
| A-AUD-02 | Hetzner persistent host available for Go+Redis | Ops decision Q-08 |
| A-AUD-03 | Cloudflare account with Workers/D1/DO available | Ops decision Q-09 |

## 9. Recommended documentation changes
- Author full `docs/00–16` set + `decisions/` + `tasks/` as specified in brief (this task).
- Do NOT scaffold source code until human approves docs + backlog.
- Next: `docs/00-project-charter.md` → `docs/16-documentation-and-backlog-audit.md`.

## 10. Secrets scan
- No files scanned; no secret values output. No `.env`, no credentials found (trivially true for empty dir).
- Policy going forward: never commit secrets; Cloudflare Secrets Store + Hetzner env via secret manager only.

---
*Links: [Charter](./00-project-charter.md) · [Assumptions](./14-assumptions-decisions-and-open-questions.md) · [Roadmap](./tasks/ROADMAP.md)*
