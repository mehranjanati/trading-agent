// execution.mjs — E09-T01: the submit path + position snapshots.
//
// THE submit path (D-08): it lives here, in Workers, and nowhere else — the Go
// Watcher never submits, including in fallback. The order of operations is the
// safety design, not an implementation detail:
//
//   kill (R-KILL is gate #1) → lease fence → risk gates → consume approval →
//   insert intent → signed submit → persist outcome
//
// Fencing is checked before anything is written, and the approval is consumed
// only AFTER the gates pass, so a rejected intent never burns a human approval.
// `client_order_id = intent_id` (FR-009 / SAFE-004), and `order_intents.
// client_order_id` is UNIQUE — one exchange order per intent, even under retry.
// A timeout is NOT a failure: it becomes SUBMIT_UNKNOWN and is reconciled by
// client id, never blind-resubmitted (§6.4).
//
// Positions are built from FILLS ONLY (FR-010) — never derived from intents.
import { uid, recordIncident } from "./_shared.mjs";
import { validate as riskValidate, addDec, mulDec, divDec, cmpDec, normDec } from "./risk.mjs";
import { consumeApproval, readApproval } from "./approvals.mjs";
import { holdsAuthority, HOLDERS } from "./lease.mjs";
import { pollStatus } from "./fallback-poll.mjs";
import { mapVenueStatus } from "./exchange.mjs";

/** Our own market data only — a caller can never hand us the price it is judged on. */
export async function priceFor(env, symbol, nowMs = Date.now()) {
  try {
    const st = await pollStatus(env, nowMs);
    const q = (st.quotes ?? []).find((x) => x.symbol === symbol);
    if (!q?.price) return null;
    return { symbol, px: String(q.price), at_ms: st.last_poll_ms ?? null };
  } catch { return null; }
}

export async function readWatch(env, id) {
  const r = await env.DB.prepare("SELECT * FROM watches WHERE id=?").bind(id).all();
  return r.results?.[0] ?? null;
}

/** Open exposure for a symbol = |size| × entry_px, exact decimal (positions only). */
export async function openExposure(env, symbol) {
  const r = await env.DB.prepare("SELECT size, entry_px FROM positions WHERE symbol=?").bind(symbol).all();
  const row = r.results?.[0];
  if (!row?.size || row.size === "0" || !row.entry_px) return "0";
  const size = row.size.startsWith("-") ? row.size.slice(1) : row.size;
  return mulDec(size, row.entry_px);
}

/** Is there already a LIVE intent for this approval? (docs/08 §8.4) */
export async function hasLiveIntent(env, approval_id) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM order_intents WHERE approval_id=? AND status IN ('SUBMITTED','SUBMIT_UNKNOWN','ACKED','PARTIAL')",
  ).bind(approval_id).all();
  return (r.results?.[0]?.n ?? 0) > 0;
}

/** Portfolio slot counts for the R-SLOT gate (docs/19 §19.7 gap 1): the number
 *  of concurrent ACTIVE watches, globally and for one symbol. A failed read is
 *  `null` (unknown) — the gate then fails closed (SAFE-001), never passes. */
export async function activeWatchCounts(env, symbol) {
  const count = async (sql, ...binds) => {
    const stmt = env.DB.prepare(sql);
    const r = await (binds.length ? stmt.bind(...binds) : stmt).all();
    const n = r.results?.[0]?.n;
    return Number.isFinite(n) ? Number(n) : null;
  };
  try {
    const total = await count("SELECT COUNT(*) AS n FROM watches WHERE status='ACTIVE'");
    const perSymbol = symbol
      ? await count("SELECT COUNT(*) AS n FROM watches WHERE status='ACTIVE' AND symbol=?", symbol)
      : null;
    return { active_watches: total, active_watches_for_symbol: perSymbol };
  } catch {
    return { active_watches: null, active_watches_for_symbol: null };
  }
}

/** D-08 fencing: only the authority holder at the current epoch may submit. */
export function fenceResult(lease, nowMs, holder = HOLDERS.PRIMARY) {
  if (holdsAuthority(lease, holder, nowMs)) return null;
  return { ok: false, code: "DEGRADED", status: 503, reason: `no authority lease for ${holder} (fenced)`, risk_code: null };
}


/** The submit path. Returns the HTTP verdict the route surfaces. */
export async function submitIntent(env, {
  approval_id, side, qty, leverage, stop_loss, exchange,
  lease, kill, limits, limits_version,
  nowMs = Date.now(), actor = "submit", holder = HOLDERS.PRIMARY,
  active_watches, active_watches_for_symbol,
}) {
  const at = new Date(nowMs).toISOString();
  const approval = await readApproval(env, approval_id);
  const watch = approval ? await readWatch(env, approval.watch_id) : null;
  const price = watch ? await priceFor(env, watch.symbol, nowMs) : null;
  const exposure = watch ? { open_notional_usd: await openExposure(env, watch.symbol) } : null;
  const live = await hasLiveIntent(env, approval_id);

  const intent = { approval_id, side, qty, leverage, ...(stop_loss !== undefined ? { stop_loss } : {}) };
  // R-SLOT evidence: the caller may supply the counts; otherwise they are read
  // from our own D1 state. Unknown stays unknown → the gate fails closed.
  // The read is skipped when the active config has no slot cap (no invented
  // limit, and no needless query on the hot submit path).
  const slotCapConfigured = (limits?.max_active_watches !== undefined && limits?.max_active_watches !== null)
    || (limits?.max_active_watches_per_symbol !== undefined && limits?.max_active_watches_per_symbol !== null);
  const slots = slotCapConfigured
    ? (active_watches === undefined || active_watches_for_symbol === undefined
        ? await activeWatchCounts(env, watch?.symbol ?? null)
        : { active_watches, active_watches_for_symbol })
    : { active_watches: undefined, active_watches_for_symbol: undefined };
  const ctx = {
    now_ms: nowMs, limits, limits_version, kill, approval, watch, price,
    exposure, live_intent_for_approval: live,
    active_watches: slots.active_watches,
    active_watches_for_symbol: slots.active_watches_for_symbol,
  };

  // 1) lease fence BEFORE any write — a fenced caller must not leave a trace
  //    that could be mistaken for an order.
  const fenced = fenceResult(lease, nowMs, holder);
  if (fenced) return fenced;

  // 2) deterministic risk gates (the only gate implementation, docs/08 §8.2)
  const verdict = riskValidate(intent, ctx);
  if (!verdict.ok) {
    // docs/08 §8.3/§8.4: a CONSUMED approval can never mint a second intent —
    // that is a conflict (409), not a risk opinion; an EXPIRED one is 410.
    if (verdict.code === "R-APPROVAL" && verdict.detail?.used_at) {
      return { ok: false, code: "CONFLICT", status: 409, reason: verdict.reason, risk_code: "R-APPROVAL", detail: verdict.detail };
    }
    if (verdict.code === "R-APPROVAL" && verdict.reason === "approval expired") {
      return { ok: false, code: "APPROVAL_EXPIRED", status: 410, reason: verdict.reason, risk_code: "R-APPROVAL", detail: verdict.detail };
    }
    await env.DB.prepare(
      "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
    ).bind(uid("evt"), "risk.rejected_v1", approval?.watch_id ?? approval_id,
      JSON.stringify({ risk_code: verdict.code, reason: verdict.reason, detail: verdict.detail }),
      `risk.rejected_v1:${approval_id}:${nowMs}`, at).run();
    return { ok: false, code: "RISK_REJECT", status: 422, risk_code: verdict.code, reason: verdict.reason, detail: verdict.detail };
  }

  // 3) consume the human approval exactly once (E08-T02). Done AFTER the gates
  //    so a rejected intent never burns an approval.
  const consumed = await consumeApproval(env, { approval_id, nowMs, actor });
  if (!consumed.ok) return consumed;

  // 4) record the intent. client_order_id = intent_id (SAFE-004); the UNIQUE
  //    constraint is what makes "one exchange order per intent" structural.
  const intent_id = uid("int");
  const client_order_id = intent_id;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO order_intents(id,watch_id,approval_id,side,qty,leverage,stop_loss,client_order_id,status,at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).bind(intent_id, watch.id, approval_id, side, qty, leverage, stop_loss ?? null, client_order_id, "RISK_PASSED", at),
    env.DB.prepare(
      "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
    ).bind(uid("evt"), "order.intent_v1", watch.id,
      JSON.stringify({ intent_id, approval_id, client_order_id, limits_version }), `order.intent_v1:${intent_id}:0`, at),
    env.DB.prepare(
      "INSERT INTO outbox(id,aggregate,payload_json,attempts,done) VALUES(?,?,?,0,0)",
    ).bind(uid("obx"), `order_intent:${intent_id}`, JSON.stringify({ intent_id })),
  ]);

  // 5) submit. A definitive answer is a state; a lost ack is SUBMIT_UNKNOWN.
  let status, exchange_order_id = null, fills = [];
  try {
    const res = await exchange.submit({ client_order_id, symbol: watch.symbol, side, qty, price: price.px, ...(stop_loss !== undefined ? { stop_loss } : {}) });
    status = mapVenueStatus(res.venue_status) ?? "SUBMITTED";
    exchange_order_id = res.exchange_order_id ?? null;
    fills = res.fills ?? [];
  } catch (e) {
    if (e?.code !== "ACK_LOST") throw e;
    status = "SUBMIT_UNKNOWN";
  }

  const eventType = status === "SUBMIT_UNKNOWN" ? "order.ack_lost_v1" : "order.submitted_v1";
  const batch = [
    env.DB.prepare("UPDATE order_intents SET status=? WHERE id=?").bind(status, intent_id),
    env.DB.prepare(
      "INSERT INTO orders(client_order_id,exchange_order_id,status,fills_json,last_reconciled_at,at) VALUES(?,?,?,?,?,?) " +
        "ON CONFLICT(client_order_id) DO UPDATE SET exchange_order_id=excluded.exchange_order_id, status=excluded.status, fills_json=excluded.fills_json, last_reconciled_at=excluded.last_reconciled_at;",
    ).bind(client_order_id, exchange_order_id, status, JSON.stringify(fills), at, at),
    env.DB.prepare(
      "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
    ).bind(uid("evt"), eventType, watch.id,
      JSON.stringify({ intent_id, client_order_id, exchange_order_id, status }), `${eventType}:${intent_id}:0`, at),
  ];
  if (status === "FILLED") {
    for (const s of await positionStatements(env, { symbol: watch.symbol, side, qty, fills, leverage, nowMs })) {
      batch.push(env.DB.prepare(s.sql).bind(...s.binds));
    }
  }
  await env.DB.batch(batch);

  if (status === "SUBMIT_UNKNOWN") {
    await recordIncident(env, "order.submit_unknown", `client_order_id=${client_order_id}`, actor);
  }
  return { ok: true, status: 201, intent_id, client_order_id, order_status: status, exchange_order_id };
}

/** Positions come from FILLS ONLY (FR-010) — never derived from intents. Returns
 *  the statements for one symbol snapshot: signed size, size-weighted entry
 *  price (exact decimal, truncated), leverage, plus the audit event. */
export async function positionStatements(env, { symbol, side, qty, fills, leverage, nowMs = Date.now() }) {
  const at = new Date(nowMs).toISOString();
  const r = await env.DB.prepare("SELECT size, entry_px FROM positions WHERE symbol=?").bind(symbol).all();
  const cur = r.results?.[0] ?? { size: "0", entry_px: null };

  // signed fill quantity from this order
  let fillQty = "0", weight = "0";
  for (const f of fills ?? []) {
    const q = String(f.qty ?? qty);
    fillQty = addDec(fillQty, q);
    weight = addDec(weight, mulDec(q, String(f.px)));
  }
  if (side === "SELL") fillQty = fillQty.startsWith("-") ? fillQty.slice(1) : `-${fillQty}`;

  const size = addDec(cur.size ?? "0", fillQty);
  const abs = (s) => (s.startsWith("-") ? s.slice(1) : s);
  const sign = (s) => (s.startsWith("-") ? -1 : 1);
  const curAbs = abs(cur.size ?? "0");
  const fillAbs = abs(fillQty);

  let entry_px = cur.entry_px ?? null;
  if (cmpDec(curAbs, "0") === 0 || !entry_px) {
    entry_px = fillAbs !== "0" ? normDec(divDec(weight, fillAbs)) : entry_px; // opened from flat
  } else if (sign(cur.size) === sign(fillQty)) {
    entry_px = normDec(divDec(addDec(mulDec(curAbs, entry_px), weight), addDec(curAbs, fillAbs))); // same side → weighted
  } else if (cmpDec(fillAbs, curAbs) >= 0) {
    entry_px = fillAbs !== "0" ? normDec(divDec(weight, fillAbs)) : entry_px; // flip / through zero
  } // else: partial reduce keeps the entry price

  return [
    {
      sql: "INSERT INTO positions(symbol,size,entry_px,leverage,updated_at) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(symbol) DO UPDATE SET size=excluded.size, entry_px=excluded.entry_px, leverage=excluded.leverage, updated_at=excluded.updated_at;",
      binds: [symbol, size, entry_px, leverage ?? cur.leverage ?? null, at],
    },
    {
      sql: "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
      binds: [uid("evt"), "position.snapshot_v1", symbol, JSON.stringify({ symbol, size, entry_px, leverage }), `position.snapshot_v1:${symbol}:${nowMs}`, at],
    },
  ];
}
