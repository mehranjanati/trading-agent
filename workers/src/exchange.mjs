// exchange.mjs — E09-T01: the exchange boundary (submit + query by client id).
//
// D-06 / docs/ops facts: Toobit has NO testnet, so the wired implementation is a
// PAPER simulator that records intents and simulates fills; the signed-REST
// client swaps in behind the same interface. The venue status vocabulary is
// fixed by the docs capture: PENDING_NEW, NEW, PARTIALLY_FILLED, FILLED,
// CANCELED, PENDING_CANCEL, REJECTED. A 5xx/timeout is NOT a rejection — it is
// an UNKNOWN outcome (docs/ops §S2), which is the whole reason reconciliation
// exists: the order may well have been placed.
export const VENUE_STATUS_MAP = {
  PENDING_NEW: "ACKED",
  NEW: "ACKED",
  PARTIALLY_FILLED: "PARTIAL",
  FILLED: "FILLED",
  CANCELED: "CANCELLED",
  PENDING_CANCEL: "CANCELLED",
  REJECTED: "REJECTED",
};
/** venue status → our FSM (docs/05 §5.4). Unknown vocabulary → null, and a null
 *  never resolves an intent (fail closed: keep polling, never invent truth). */
export function mapVenueStatus(status) { return VENUE_STATUS_MAP[status] ?? null; }

/** Ack-lost / 5xx. Carries no verdict — the caller must reconcile. */
export function ackLost(reason = "timeout waiting for ack") {
  const e = new Error(reason);
  e.code = "ACK_LOST";
  return e;
}

/** Deterministic paper exchange. `loseAck` models the §5.6 sequence exactly: the
 *  venue ACCEPTS the order and the response is lost, so a later query finds it. */
export function createPaperExchange({ loseAck = false, fill = true, reject = false, ttlFills = 1 } = {}) {
  const orders = new Map(); // client_order_id -> { exchange_order_id, venue_status, fills }
  let seq = 0;
  return {
    orders,
    async submit({ client_order_id, symbol, side, qty, price }) {
      const exchange_order_id = `EX${String(++seq).padStart(6, "0")}`;
      if (reject) {
        orders.set(client_order_id, { exchange_order_id: null, venue_status: "REJECTED", fills: [] });
        return { exchange_order_id: null, venue_status: "REJECTED", fills: [] };
      }
      const fills = fill ? Array.from({ length: ttlFills }, () => ({ px: price, qty })) : [];
      orders.set(client_order_id, {
        exchange_order_id, venue_status: fill ? "FILLED" : "NEW", fills,
      });
      if (loseAck) throw ackLost(); // placed, but we never saw the answer
      return { exchange_order_id, venue_status: fill ? "FILLED" : "NEW", fills };
    },
    /** Reconcile seam: the only truthful source of order state. */
    async query(client_order_id) {
      const o = orders.get(client_order_id);
      return o ? { ...o } : null;
    },
  };
}

/** Adapter to `reconcile.sweep`'s resolver seam (E06-T02-S3a). It NEVER invents a
 *  status: a null/short answer leaves the intent unresolved, which is what keeps
 *  SUBMIT_UNKNOWN reconcile-only instead of a blind resubmit (§6.4). */
export function exchangeResolver(exchange) {
  return {
    async intent(row) {
      const q = await exchange.query(row.client_order_id);
      if (!q) return null;
      const status = mapVenueStatus(q.venue_status);
      if (!status) return null;
      return { status, exchange_order_id: q.exchange_order_id, fills: q.fills ?? [] };
    },
    async order(row) {
      const q = await exchange.query(row.client_order_id);
      if (!q?.exchange_order_id) return null;
      return { exchange_order_id: q.exchange_order_id, status: mapVenueStatus(q.venue_status) ?? row.status };
    },
  };
}
