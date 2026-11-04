# Tasks — How to use this backlog

- Source of truth: `BACKLOG.json` v2.2.0 — 29 tasks, 77 subtasks, stack TS+Go only. E15 (cockpit, docs/20) and E16 (live-trading readiness gate, docs/21) are PROPOSED; E16 adds no live capability by itself.
- Human views: `ROADMAP.md` (waves), `EPICS.md` (exits), `DEPENDENCY-GRAPH.md` (mermaid), `MODEL-ASSIGNMENTS.md`, `TEST-AND-RELEASE-GATES.md`.
- Task fields: id, epic, title, objective, scope, out_of_scope, priority, risk, dependencies, affected_components, implementation_steps, acceptance_criteria (Given/When/Then), test_plan, documentation_references, model_assignment, estimated_complexity (S/M/L/XL + justification in epic), status, blocking_decisions, subtasks[] (each: id, title, output, acceptance).
- Subtask rules: independently reviewable, concrete verifiable output, no bare research/improve/fix without stated artifact.
- Statuses: DONE (E00-T01) → IN_REVIEW (E00-T02) → PROPOSED → READY → IN_PROGRESS → IN_REVIEW → DONE; BLOCKED (E02-T01/T02 on A-01/A-02).
- Validate: `node scripts/validate-backlog.mjs`. Complexity: S ≤1 session, M 2–3, L 4–8 (needs split), XL epic-scale drill programs.
