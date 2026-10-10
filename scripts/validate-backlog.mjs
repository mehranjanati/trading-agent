#!/usr/bin/env node
// validate-backlog.mjs — BACKLOG.json schema + dependency check (Node, no Python).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const d = JSON.parse(readFileSync(join(root, "docs/tasks/BACKLOG.json"), "utf8"));
const ids = new Set(d.tasks.map((t) => t.id));
const bad = d.tasks.flatMap((t) => t.dependencies.filter((x) => !ids.has(x)));
if (bad.length) { console.error("BAD DEPS:", bad); process.exit(1); }
const req = ["id","epic_id","title","objective","scope","out_of_scope","priority","risk_level","dependencies","affected_components","implementation_steps","acceptance_criteria","test_plan","documentation_references","model_assignment","estimated_complexity","status","blocking_decisions"];
for (const t of d.tasks) {
  const miss = req.filter((k) => !(k in t));
  if (miss.length) { console.error(t.id, "missing", miss); process.exit(1); }
}
console.log(`BACKLOG OK: ${ids.size} tasks, deps OK`);
