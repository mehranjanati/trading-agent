// timeline.mjs — E04-T02-S2: append-only events/signals + per-entity timeline query.
// S2 acceptance: every stored trigger yields transition + event rows; illegal edges 409.
import { guardTransition } from "./watches.mjs";
export const SIGNAL_KINDS = ["DIVERGENCE_TRIPLE", "ORDER_BLOCK", "OB_OS", "MTF", "REGIME"];
export function signalInsertSql(s) {
  if (!SIGNAL_KINDS.includes(s.kind)) {
    const e = new Error(`unknown signal kind ${s.kind}`); e.code = 400; throw e;
  }
  return `INSERT INTO signals(id,watch_id,kind,payload_json,source,at) VALUES('${s.id}','${s.watch_id}','${s.kind}','${s.payload_json}','${s.source}','${s.at}');`;
}
export function eventAppendSql(e) {
  return `INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES('${e.id}','${e.type}','${e.entity_id}','${e.payload_json}','${e.dedupe_key}','${e.at}');`;
}
// Full ordered history for one entity (events + transitions + signals + runs + approvals).
export function timelineSql(entityId) {
  return [
    `SELECT at, type AS kind, id, payload_json AS body FROM events WHERE entity_id='${entityId}'`,
    `UNION ALL SELECT at, 'transition:'||from_s||'->'||to_s, id, reason FROM watch_transitions WHERE watch_id='${entityId}'`,
    `UNION ALL SELECT at, 'signal:'||kind, id, payload_json FROM signals WHERE watch_id='${entityId}'`,
    `ORDER BY at;`,
  ].join("\n");
}
export { guardTransition };
