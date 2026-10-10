// validate.mjs — E05-T01-S1/S2: request validators (pure, testable).
// Shapes per docs/10 §10.2. All money fields are decimal strings, never floats.
const SYM = /^[A-Z]{2,12}USDT$/;
const DIR = new Set(["LONG", "SHORT"]);
const SIDE = new Set(["BUY", "SELL"]);
const DECISION = new Set(["approve", "reject"]);
const KINDS = new Set(["DIVERGENCE_TRIPLE", "ORDER_BLOCK", "OB_OS", "MTF", "REGIME"]);

function need(cond, msg) {
  if (!cond) { const e = new Error(msg); e.code = "VALIDATION"; throw e; }
}
function decStr(v, name) {
  need(typeof v === "string" && /^\d+(\.\d+)?$/.test(v), `${name} must be decimal string`);
}
export function watchBody(b) {
  need(b && typeof b === "object", "body required");
  need(SYM.test(b.symbol ?? ""), "symbol must match ^[A-Z]{2,12}USDT$");
  need(DIR.has(b.direction), "direction LONG|SHORT");
  need(b.trigger && typeof b.trigger.op === "string", "trigger.op required");
  need(["cross_above", "cross_below", ">=", "<="].includes(b.trigger.op), "trigger.op unknown");
  decStr(b.trigger.price, "trigger.price");
  return true;
}
export function signalBody(b) {
  need(b && typeof b === "object", "body required");
  need(KINDS.has(b.kind), "kind must be one of 5 signal kinds");
  need(b.payload && typeof b.payload === "object", "payload object required");
  need(typeof b.source === "string" && b.source.length > 0, "source required");
  return true;
}
export function approvalBody(b) {
  need(b && typeof b === "object", "body required");
  need(typeof b.watch_id === "string" && b.watch_id, "watch_id required");
  need(typeof b.analysis_id === "string" && b.analysis_id, "analysis_id required");
  need(DECISION.has(b.decision), "decision approve|reject");
  return true;
}
export function intentBody(b) {
  need(b && typeof b === "object", "body required");
  need(typeof b.approval_id === "string" && b.approval_id, "approval_id required");
  need(SIDE.has(b.side), "side BUY|SELL");
  decStr(b.qty, "qty");
  need(Number.isInteger(b.leverage) && b.leverage >= 1 && b.leverage <= 100, "leverage 1..100");
  return true;
}
