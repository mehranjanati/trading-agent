// watches.mjs — E04-T02-S1: Watch repo + FSM transition guards (D1 dialect).
// Every edge writes watch_transitions + events + outbox in ONE batch (E05 executes;
// pure SQL builders here so logic is unit-testable without a D1 binding).
// FSM per docs/05 §5.3: DRAFT→ACTIVE→TRIGGERED→ANALYZED→APPROVED→ORDERED→CLOSED (+INVALIDATED/EXPIRED).
export const WATCH_EDGES = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["TRIGGERED", "INVALIDATED", "EXPIRED"],
  TRIGGERED: ["ANALYZED"],
  ANALYZED: ["APPROVED", "CLOSED"],
  APPROVED: ["ORDERED", "CLOSED"],
  ORDERED: ["CLOSED"],
  INVALIDATED: [], EXPIRED: [], CLOSED: [],
};
export function guardTransition(from, to) {
  const allowed = WATCH_EDGES[from] ?? [];
  if (!allowed.includes(to)) {
    const e = new Error(`illegal watch transition ${from}→${to}`);
    e.code = 409; e.transition = { from, to };
    throw e;
  }
}
// SQL: optimistic-concurrency update (version check) + transition row.
export function transitionSql(watchId, from, to, expectedVersion, meta) {
  guardTransition(from, to);
  const { tid, reason, actor, at } = meta;
  return [
    `UPDATE watches SET status='${to}', version=version+1, updated_at='${at}' WHERE id='${watchId}' AND version=${expectedVersion} AND status='${from}';`,
    `INSERT INTO watch_transitions(id,watch_id,from_s,to_s,reason,actor,at) VALUES('${tid}','${watchId}','${from}','${to}','${reason}','${actor}','${at}');`,
  ].join("\n");
}
// The same edge as PREPARED statements (bound params), for callers that write it
// inside a D1 batch: `actor` comes from a request header and must never be
// interpolated into SQL. The FSM guard still runs first, so an illegal edge is a
// 409 before anything is written.
//
// The audit row is inserted FIRST and both statements carry the SAME guard
// (id + expectedVersion + from-status), so inside one D1 transaction either both
// apply or neither does: a stale or duplicate call can never leave a transition
// row for an edge that did not happen. The order matters — the UPDATE would
// invalidate the guard for the INSERT if it ran first.
export function transitionStatements(env, { id, from, to, expectedVersion, tid, reason, actor, at }) {
  guardTransition(from, to);
  return [
    env.DB.prepare(
      "INSERT INTO watch_transitions(id,watch_id,from_s,to_s,reason,actor,at) " +
        "SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM watches WHERE id=? AND version=? AND status=?)",
    ).bind(tid, id, from, to, reason, actor, at, id, expectedVersion, from),
    env.DB.prepare(
      "UPDATE watches SET status=?, version=version+1, updated_at=? WHERE id=? AND version=? AND status=?",
    ).bind(to, at, id, expectedVersion, from),
  ];
}
// SQL: active snapshot for Go cold-start (R-01) — ordered, version-pinned.
export function activeSnapshotSql() {
  return `SELECT id,symbol,direction,trigger_json,invalidation_json,status,version,expires_at FROM watches WHERE status='ACTIVE' ORDER BY symbol,id;`;
}
