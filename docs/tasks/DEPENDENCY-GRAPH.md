# Dependency Graph (task-level, acyclic — validated by `node scripts/validate-backlog.mjs`)

```mermaid
flowchart TB
  E00T01[E00-T01 DONE] --> E00T02[E00-T02 IN_REVIEW]
  E00T01 --> E01T01[E01-T01] --> E01T02[E01-T02]
  E01T01 --> E04T01[E04-T01] --> E04T02[E04-T02]
  E04T01 --> E02T01[E02-T01 BLOCKED]
  E02T01 --> E02T02[E02-T02 BLOCKED] --> E03T01[E03-T01] --> E03T02[E03-T02]
  E04T02 --> E05T01[E05-T01] --> E05T02[E05-T02] --> E06T01[E06-T01] --> E06T02[E06-T02]
  E05T01 --> E07T01[E07-T01]
  E05T01 --> E12T01[E12-T01]
  E05T01 --> E10T01[E10-T01]
  E06T01 --> E08T01[E08-T01] --> E08T02[E08-T02] --> E09T01[E09-T01]
  E09T01 & E10T01 & E12T01 --> E11T01[E11-T01 GATE]
```

- P0 chain: E00→E01→E04→E06→E08→E09→E11. No cycles (validator asserts all deps resolve; wave order above is topological).
- External blocks: E02-T01/T02 on A-01/A-02 (Toobit docs). E10 unblocked (Q-01 SvelteKit decided 2026-10-10).
