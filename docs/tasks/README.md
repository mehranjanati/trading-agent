# Tasks — How to use this backlog

- Source of truth: `BACKLOG.json` (machine-readable). Human views: `ROADMAP.md`, `EPICS.md`, `DEPENDENCY-GRAPH.md`.
- Task fields per brief §phase_3 (id, epic, title, objective, scope, out_of_scope, priority, risk, deps, components, steps, acceptance Given/When/Then, test plan, doc refs, model, complexity S/M/L/XL, status, blocking decisions).
- Statuses: PROPOSED→READY→IN_PROGRESS→IN_REVIEW→DONE; BLOCKED if decision/verify pending.
- Rules: no circular deps; P0 before dependents; security/safety tags; VERIFY tags need official-doc URL+date.
- Validate: `python3 -c "import json;json.load(open('docs/tasks/BACKLOG.json'))"` + link check.
