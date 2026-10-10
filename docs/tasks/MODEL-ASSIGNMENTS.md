# Model Assignments per task category

| Category | Primary | Reviewer | Why | Manual switch | Verification | Fallback |
|---|---|---|---|---|---|---|
| E00/E01 scaffolding | MiMo-V2.6-Flash | Spark 1.3 | cheap + broad | select Flash | CI green | Spark |
| E02–E05 build | DeepSeek V4.1 Flash | Spark 1.3 | focused impl | select per task | tests+soak | Spark |
| E06/E08/E09 safety | GLM-5.3 | Qwen3.8 Max | critical reasoning | switch to Max for review | drills green | GLM-5.3 |
| E07/E10 product | Spark 1.3 | GLM-5.3-Flash | context + iteration | switch as needed | contract tests | Flash |
| E11/E12 release | Qwen3.8 Max | human | independence | switch to Max | gate report | GLM-5.3 |
