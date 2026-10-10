# 15 — Model Routing & AI Workflow (cost-aware, manual switches)

> The agent cannot auto-switch models. The human (or IDE) selects the model at each switch point below. Author and reviewer must differ on E06/E08/E09 changes.

## 15.1 Assignment table
| Work | Primary | Reviewer | Why | Switch point | Verification | Fallback |
|---|---|---|---|---|---|---|
| Recon / scaffolding (E00–E01) | MiMo-V2.6-Flash | Muse Spark 1.3 | cheap breadth, structured drafts | user selects Flash in IDE | `make check` green | Spark |
| Reqs / architecture (docs 00–10) | Muse Spark 1.3 | GLM-5.3 | long-context synthesis | switch to GLM-5.3 for critique pass | audit §16 checklist | Spark |
| Backlog decomposition (E-tasks) | GLM-5.3-Flash | Spark 1.3 | fast structured output | switch to Flash | JSON schema + acyclic check | Spark |
| Feature code + tests (E02–E05, E07, E10, E12) | DeepSeek V4.1 Flash | Spark 1.3 | focused multi-step impl | select per task | tests green + contract tests | Spark |
| Safety / failover / execution (E06, E08, E09) | GLM-5.3 | Qwen3.8 Max | deep reasoning + adversarial review | switch to Max for review | drills green (kill/ack-loss/split-brain) | GLM-5.3 |
| Final gate (E11) | Qwen3.8 Max | human | independence | switch to Max | 14-day paper report + sign-off | — |

## 15.2 Rules
1. Model reputation is never evidence — tests, drills and doc links are.
2. Safety PRs record `author-model / reviewer-model / date` in the description.
3. Prefer the cheapest model that can meet the verification bar; escalate only on red.
4. If a model is unavailable, use the Fallback column and note the swap in the PR.
