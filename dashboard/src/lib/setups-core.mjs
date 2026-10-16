// setups-core.mjs — the pure room logic: which watches belong to a symbol, and
// what that makes the room's status. No Svelte, no DOM, no storage, so
// `node --test` imports the REAL implementation instead of a hand-copied mirror
// (the freshness.mjs / groups-core.mjs / library-core.mjs pattern).
//
// REGRESSION THIS PINS: the room read `/api/watches?status=ACTIVE` and derived
// EVERY link from that ACTIVE-only list (the watch rows, and — through their ids
// — the approvals, the orders and the analysis runs). The watch FSM never
// deletes a row (docs/05 §5.3): it moves ACTIVE→TRIGGERED→ANALYZED, or
// ACTIVE→INVALIDATED|EXPIRED. So the instant a stalked zone did its job, the
// watch and everything linked to it vanished from the room at once and the trade
// read as deleted instead of in progress — while D1 still held every row and the
// Go trigger loop had merely posted one edge.
//
// The rule now: the room reads the symbol's FULL watch history (ACTIVE first,
// then newest), and the ids of ALL of those watches are the join key.

/** @typedef {{ id: string, symbol: string, status: string, direction?: string,
 *              version?: number, updated_at?: string }} RoomWatch */

const ACTIVE = "ACTIVE";

/** ts — epoch ms of an ISO stamp; a missing/unparsable one sorts as oldest.
 *  @param {string|undefined|null} iso
 *  @returns {number} */
function ts(iso) {
  const n = Date.parse(iso ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** roomWatches — the symbol's watches across the WHOLE lifecycle, ACTIVE first.
 *
 *  Ordering keeps what is live at the top (ACTIVE, then newest first) so the
 *  card reads like the desk: what is armed now, then what it did. A watch is
 *  never hidden for having left ACTIVE — that is the state the trader is waiting
 *  for, and hiding it is what made the trade look deleted.
 *  @param {RoomWatch[]|null|undefined} watches
 *  @param {string} symbol
 *  @returns {RoomWatch[]} */
export function roomWatches(watches, symbol) {
  return (watches ?? [])
    .filter((w) => w && w.symbol === symbol)
    .slice()
    .sort((a, b) => {
      const aActive = a.status === ACTIVE ? 0 : 1;
      const bActive = b.status === ACTIVE ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return ts(b.updated_at) - ts(a.updated_at) || String(a.id).localeCompare(String(b.id));
    });
}

/** roomWatchIds — the ids of EVERY watch of the symbol (not just ACTIVE ones):
 *  the join key for the room's approvals, orders and analysis runs. A watch that
 *  just triggered is exactly the one whose approval must stay visible.
 *  @param {RoomWatch[]|null|undefined} watches
 *  @param {string} symbol
 *  @returns {string[]} */
export function roomWatchIds(watches, symbol) {
  return roomWatches(watches, symbol).map((w) => w.id);
}

/** deriveStatus — one symbol's room status from live API snapshots (no new
 *  endpoints).
 *
 *  `watches` and `watchIds` must be the symbol's FULL watch history (roomWatches /
 *  roomWatchIds): STALKING is decided by an ACTIVE watch, while an approval stays
 *  pending AFTER its watch left ACTIVE — with an ACTIVE-only list a symbol that
 *  is in fact awaiting approval reported IDLE, and the approval it is waiting on
 *  was not even reachable from the room.
 *
 *  @param {string} symbol
 *  @param {{ positions: { symbol: string, size: string }[],
 *            watches: RoomWatch[],
 *            approvals: { watch_id: string, used_at: string|null, expires_at: string }[],
 *            watchIds: string[] }} snap
 *  @returns {"OPEN"|"STALKING"|"AWAITING-APPROVAL"|"IDLE"} */
export function deriveStatus(symbol, snap) {
  const pos = snap.positions.find((p) => p.symbol === symbol);
  if (pos && pos.size !== "0" && pos.size !== "") return "OPEN";
  const now = Date.now();
  const awaiting = snap.approvals.some(
    (a) => snap.watchIds.includes(a.watch_id) && !a.used_at && Date.parse(a.expires_at) > now,
  );
  if (awaiting) return "AWAITING-APPROVAL";
  if (snap.watches.some((w) => w.symbol === symbol && w.status === ACTIVE)) return "STALKING";
  return "IDLE";
}
