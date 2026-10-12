// reconcile.mjs — E06-T02-S3a: §6.5 reconciliation sweep (Workers side).
//
// Inventory (§6.5): order_intents in a non-terminal state (SUBMITTED, SUBMIT_UNKNOWN,
// ACKED, PARTIAL) + orders still missing an exchange_order_id. Resolution goes through
// an injectable seam: the paper/default resolver resolves NOTHING (recovery must never
// invent exchange truth), and E09 owns the real `GET order by client_order_id` poll
// (§6.4). Cadence: a fixed-id cursor row (`health_snapshots.id='sweep_reconcile'`) —
// sweep when the cursor is ≥15s old, and on every tick while mode ≠ PRIMARY.
//
// Outputs: the live non-terminal count (`rejoin.non_terminal_intents` of §6.3 condition
// 2), the `reconcile.complete` incident the drills assert on, and audit rows written
// through the E04 timeline/outbox pattern. It never INSERTs an intent: §6.4 — an
// approval is consumed by its first intent, so recovery can only resolve, never resubmit.
import { recordIncident, uid } from "./_shared.mjs";
import { eventAppendSql } from "./timeline.mjs";

export const NON_TERMINAL = ["SUBMITTED", "SUBMIT_UNKNOWN", "ACKED", "PARTIAL"];
export const TERMINAL = ["FILLED", "REJECTED", "CANCELLED", "EXPIRED"];
/** E09-T01: states the venue can report that are progress but NOT the end —
 *  persisted, yet still counted as live by the §6.3 rejoin gate. */
export const INTERMEDIATE = ["ACKED", "PARTIAL"];
export const SWEEP_MS = 15_000; // §6.5: "swept every 15s + on every recovery"
export const SWEEP_ID = "sweep_reconcile"; // fixed id → the cursor never grows the table
export const RECONCILE_INCIDENT = "reconcile.complete"; // chaos.mjs asserts this name

/** §6.5 inventory A: intents that still need exchange truth. */
export function intentInventorySql() {
  const list = NON_TERMINAL.map((s) => `'${s}'`).join(",");
  return `SELECT id, approval_id, client_order_id, status, at FROM order_intents WHERE status IN (${list}) ORDER BY at, id;`;
}

/** §6.5 inventory B: orders the exchange never acknowledged with an id. */
export function orderInventorySql() {
  return "SELECT client_order_id, status, at FROM orders WHERE exchange_order_id IS NULL ORDER BY at, client_order_id;";
}

/** Paper-mode default: resolve nothing. A resolver that returned a terminal state
 *  without asking the venue would fabricate fills — the one thing reconciliation exists
 *  to prevent, so the safe default is "still unknown, keep polling". */
export const paperResolver = { intent: () => null, order: () => null };

/** §6.5 cadence: cursor age ≥ 15s, or every tick while the system is not PRIMARY. */
export function shouldSweep(cursor, nowMs, mode = "PRIMARY") {
  if (mode && mode !== "PRIMARY") return true;
  if (!cursor?.at) return true; // first sweep ever
  const age = nowMs - Date.parse(cursor.at);
  return !Number.isFinite(age) || age >= SWEEP_MS;
}

/** Pure statement builders (no env): the sweep's writes are testable without a DB. */
export function resolutionStatements(row, outcome, nowIso) {
  const detail = JSON.stringify({
    intent_id: row.id,
    exchange_order_id: outcome.exchange_order_id ?? null,
    status: outcome.status,
  });
  return [
    { sql: "UPDATE order_intents SET status=? WHERE id=?;", binds: [outcome.status, row.id] },
    {
      sql: "INSERT INTO orders(client_order_id,exchange_order_id,status,fills_json,last_reconciled_at,at) VALUES(?,?,?,?,?,?) " +
        "ON CONFLICT(client_order_id) DO UPDATE SET exchange_order_id=excluded.exchange_order_id, " +
        "status=excluded.status, fills_json=excluded.fills_json, last_reconciled_at=excluded.last_reconciled_at;",
      binds: [
        row.client_order_id,
        outcome.exchange_order_id ?? null,
        outcome.status,
        JSON.stringify(outcome.fills ?? []),
        nowIso,
        row.at ?? nowIso,
      ],
    },
    // E04 pattern: audit event (dedupe_key UNIQUE = idempotency) + outbox in one commit.
    {
      sql: eventAppendSql({
        id: uid("evt"),
        type: "order.reconciled_v1",
        entity_id: row.id,
        payload_json: detail,
        dedupe_key: `order.reconciled_v1:${row.id}:${outcome.status}`,
        at: nowIso,
      }),
    },
    {
      sql: "INSERT INTO outbox(id,aggregate,payload_json,claimed_by,attempts,next_retry,done) VALUES(?,?,?,NULL,0,NULL,0);",
      binds: [uid("ob"), `order_intent:${row.id}`, detail],
    },
  ];
}

/** Inventory B resolution: the exchange finally gave us the order id. */
export function orderResolutionStatement(row, outcome, nowIso) {
  return {
    sql: "UPDATE orders SET exchange_order_id=?, status=?, last_reconciled_at=? WHERE client_order_id=?;",
    binds: [outcome.exchange_order_id, outcome.status ?? row.status, nowIso, row.client_order_id],
  };
}

/** §6.4 rule: one approval never yields two intents (chaos.mjs asserts the same). */
export function duplicateApprovalIntents(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.approval_id, (counts.get(r.approval_id) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([approval_id, n]) => ({ approval_id, n }));
}

export async function applyStatements(env, list) {
  if (!list.length) return 0;
  await env.DB.batch(list.map((s) => env.DB.prepare(s.sql).bind(...(s.binds ?? []))));
  return list.length;
}

export async function readCursor(env) {
  const row = await env.DB.prepare(
    "SELECT at, detail_json FROM health_snapshots WHERE id='" + SWEEP_ID + "'",
  ).all();
  const last = row.results?.[0];
  if (!last) return { at: null, remaining: null, resolved: null, complete_reported: 0 };
  let d = {};
  try { d = JSON.parse(last.detail_json ?? "{}"); } catch { d = {}; }
  return {
    at: last.at,
    remaining: d.remaining ?? null,
    resolved: d.resolved ?? null,
    complete_reported: d.complete_reported ? 1 : 0,
  };
}

async function writeCursor(env, { at, remaining, resolved, complete_reported }) {
  const status = remaining === 0 ? "COMPLETE" : "IN_PROGRESS";
  await env.DB.prepare(
    "INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES(?,'reconcile',?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, at=excluded.at",
  ).bind(SWEEP_ID, status, JSON.stringify({ remaining, resolved, complete_reported: complete_reported ? 1 : 0 }), at).run();
}

const rowsOf = async (env, sqlText) => (await env.DB.prepare(sqlText).all()).results ?? [];

/** sweep — one §6.5 pass. Returns the live counts that feed the §6.3 rejoin gate.
 *  Deliberately NOT swallowing DB errors: a sweep that cannot read must never look like
 *  "nothing to reconcile" — the caller fails closed on a thrown error. */
export async function sweep(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const mode = opts.mode ?? "PRIMARY";
  const resolve = { ...paperResolver, ...(opts.resolve ?? {}) };
  const actor = opts.actor ?? "reconcile-sweep";
  const cursor = opts.cursor ?? (await readCursor(env));

  const intents = await rowsOf(env, intentInventorySql());
  const orders = await rowsOf(env, orderInventorySql());

  const statements = [];
  const resolvedIntents = [];
  const progressedIntents = [];
  for (const row of intents) {
    const outcome = await resolve.intent(row);
    if (!outcome) continue; // unknown → keep polling (§6.4)
    if (TERMINAL.includes(outcome.status)) {
      statements.push(...resolutionStatements(row, outcome, nowIso));
      resolvedIntents.push(row.id);
    } else if (INTERMEDIATE.includes(outcome.status)) {
      // E09-T01: the venue gave us progress (ACKED / PARTIAL). Persist it — the row
      // and the order view must reflect reality — but the intent is still LIVE, so
      // it must NOT count as reconciled. Counting it would clear the §6.3 gate and
      // declare an all-clear while an order is still working.
      statements.push(...resolutionStatements(row, outcome, nowIso));
      progressedIntents.push(row.id);
    }
  }
  const resolvedOrders = [];
  for (const row of orders) {
    const outcome = await resolve.order(row);
    if (!outcome?.exchange_order_id) continue;
    statements.push(orderResolutionStatement(row, outcome, nowIso));
    resolvedOrders.push(row.client_order_id);
  }
  await applyStatements(env, statements);

  const intentsRemaining = intents.length - resolvedIntents.length;
  const ordersRemaining = orders.length - resolvedOrders.length;
  const remaining = intentsRemaining + ordersRemaining;
  const resolved = resolvedIntents.length + resolvedOrders.length;
  // Certify once per degraded episode (or when this very sweep cleared the last
  // non-terminal): the incident must exist BEFORE the PRIMARY row (acceptance 2).
  const certify = remaining === 0 && !cursor.complete_reported && (mode !== "PRIMARY" || resolved > 0);
  const completeReported = remaining === 0 ? (certify ? 1 : cursor.complete_reported) : 0;
  await writeCursor(env, { at: nowIso, remaining, resolved, complete_reported: completeReported });
  if (certify) await recordIncident(env, RECONCILE_INCIDENT, `resolved=${resolved} remaining=0 mode=${mode}`, actor);

  return {
    at: nowIso,
    mode,
    swept: intents.length + orders.length,
    resolved,
    remaining,
    intents_remaining: intentsRemaining,
    orders_remaining: ordersRemaining,
    progressed: progressedIntents.length,
    certified: certify,
    complete_reported: completeReported,
  };
}