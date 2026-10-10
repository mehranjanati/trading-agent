# Model Assignments (per task — primary / reviewer / switch / verification)

| Task(s) | Primary | Reviewer | Why | Manual switch | Verification | Fallback |
|---|---|---|---|---|---|---|
| E00-T01/T02, E01-T01 | MiMo-V2.6-Flash | Muse Spark 1.3 | cheap breadth, structured docs | select Flash in IDE | `make check` green | Spark |
| E01-T02, E07-T01, E10-T01 | Muse Spark 1.3 | GLM-5.3-Flash | context + iteration on specs/UI | select per task | contract/schema tests | Flash |
| E02-T02, E03-T01/T02, E04-T01/T02, E05-T01, E12-T01 | DeepSeek V4.1 Flash | Muse Spark 1.3 | focused multi-step impl | select per task | unit+integration green, soak logs | Spark |
| E05-T02, E08-T02 | Muse Spark 1.3 | Qwen3.8 Max / GLM-5.3 | coordination design + review | switch to Max for review | split-brain + race tests | GLM-5.3 |
| E06-T01/T02, E08-T01, E09-T01 | GLM-5.3 | Qwen3.8 Max | high-impact safety reasoning | switch to Max for review | drills green (kill/ack-loss/fencing) | GLM-5.3 |
| E02-T01 (research) | MiMo-V2.6-Flash | Muse Spark 1.3 | doc capture + citation | select Flash | URL+date in ADR-004 | Spark |
| E11-T01 (gate) | Qwen3.8 Max | human | independence | switch to Max | 14-day report + sign-off | — |

Rules: author ≠ reviewer on E06/E08/E09; record `author-model / reviewer-model / date` in safety PRs; reputation is never evidence.
