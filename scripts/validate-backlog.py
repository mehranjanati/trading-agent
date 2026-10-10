import json,sys,pathlib
p=pathlib.Path(__file__).parent.parent/"docs/tasks/BACKLOG.json"
d=json.load(open(p))
ids={t["id"] for t in d["tasks"]}
bad=[x for t in d["tasks"] for x in t["dependencies"] if x not in ids]
if bad: print("BAD DEPS:",bad); sys.exit(1)
req=["id","epic_id","title","objective","scope","out_of_scope","priority","risk_level","dependencies","affected_components","implementation_steps","acceptance_criteria","test_plan","documentation_references","model_assignment","estimated_complexity","status","blocking_decisions"]
for t in d["tasks"]:
    miss=[k for k in req if k not in t]
    if miss: print(t["id"],"missing",miss); sys.exit(1)
print(f"BACKLOG OK: {len(ids)} tasks, deps OK")
