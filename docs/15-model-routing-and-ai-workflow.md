# 15 — Model Routing & AI Workflow

Cost-conscious routing; manual switch points (agent cannot auto-switch). Author vs reviewer must differ for safety docs.

| Work | Primary | Reviewer | Why | Manual switch | Verify | Fallback |
|---|---|---|---|---|---|---|
| Recon/scaffold | MiMo-V2.6-Flash | — | cheap breadth | user selects in IDE | file list | — |
| Reqs/arch draft | Muse Spark 1.3 | GLM-5.3 | context synthesis | switch to GLM-5.3 | cross-doc review | Spark |
| Backlog/decomp | GLM-5.3-Flash | Spark 1.3 | structured speed | switch to Flash | JSON validate+acyclic check | Spark |
| Code/tests | DeepSeek V4.1 Flash | Spark 1.3 | focused impl | switch per task | tests green | Flash |
| Safety/failover review | GLM-5.3 | Qwen3.8 Max | deep critique | switch to Max | drill results | GLM-5.3 |
| Final audit | Qwen3.8 Max | human | independence | switch to Max | checklist §16 | GLM-5.3 |

Rules: no model reputation as proof; tests+inspection required; record model+date in PR for safety changes.
