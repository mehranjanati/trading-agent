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
// ── Room links: what a room has IN PLAY (advisory linkage only) ───────────────
//
// A room's `strategies` / `groups` are the trader's own selection (canonical
// trading state stays in D1). They used to be APPEND-ONLY: the strategies page
// could link a group to a symbol and nothing could take it back, and
// `SymbolSetup.strategies` was written by NOBODY — so the room's "strategies in
// play" was permanently empty and a linked group could not be removed. Every
// mutation below returns a NEW rooms map (never in place), so the store update
// has the same shape as the rest of setups.ts, and every one is idempotent.

/** @typedef {{ id: string, version?: string }} StrategyRef */
/** @typedef {{ symbol: string, chatSession: string|null, strategies: StrategyRef[],
 *              groups: string[], analyzes: string[], watches: string[],
 *              updatedAt: string }} Room */

/** strategyRefKey — the identity a room's strategy list dedupes on: the same id
 *  at a different version is a DIFFERENT entry (mirrors library entryKey).
 *  @param {StrategyRef} e
 *  @returns {string} */
export function strategyRefKey(e) {
  return `${e?.id}@${e?.version ?? "latest"}`;
}

/** @param {string} symbol @returns {Room} */
function blankRoom(symbol) {
  return { symbol, chatSession: null, strategies: [], groups: [], analyzes: [], watches: [], updatedAt: new Date().toISOString() };
}

/** withRoom — apply `fn` to one room's copy and return a new rooms map. A missing
 *  room is created: linking a strategy IS creating the room.
 *  @param {Record<string, Room>|null|undefined} rooms
 *  @param {string} symbol
 *  @param {(room: Room) => Room} fn
 *  @returns {Record<string, Room>} */
function withRoom(rooms, symbol, fn) {
  const key = String(symbol ?? "").trim().toUpperCase();
  if (!key) return rooms ?? {};
  const cur = (rooms ?? {})[key] ?? blankRoom(key);
  return { ...(rooms ?? {}), [key]: { ...fn({ ...cur }), symbol: key, updatedAt: new Date().toISOString() } };
}

/** linkStrategy — add one id@version to a room (no-op when already there).
 *  @param {Record<string, Room>|null|undefined} rooms @param {string} symbol @param {StrategyRef} entry */
export function linkStrategy(rooms, symbol, entry) {
  return withRoom(rooms, symbol, (r) => {
    const k = strategyRefKey(entry);
    if (r.strategies.some((s) => strategyRefKey(s) === k)) return r;
    return { ...r, strategies: [...r.strategies, { id: entry.id, version: entry.version }] };
  });
}

/** unlinkStrategy — remove one id@version from a room.
 *  @param {Record<string, Room>|null|undefined} rooms @param {string} symbol @param {StrategyRef} entry */
export function unlinkStrategy(rooms, symbol, entry) {
  return withRoom(rooms, symbol, (r) => {
    const k = strategyRefKey(entry);
    return { ...r, strategies: r.strategies.filter((s) => strategyRefKey(s) !== k) };
  });
}

/** linkGroup — link a group to a room (idempotent).
 *  @param {Record<string, Room>|null|undefined} rooms @param {string} symbol @param {string} name */
export function linkGroup(rooms, symbol, name) {
  return withRoom(rooms, symbol, (r) => (
    r.groups.includes(name) ? r : { ...r, groups: [...r.groups, name] }
  ));
}

/** unlinkGroup — remove a group link from a room.
 *  @param {Record<string, Room>|null|undefined} rooms @param {string} symbol @param {string} name */
export function unlinkGroup(rooms, symbol, name) {
  return withRoom(rooms, symbol, (r) => ({ ...r, groups: r.groups.filter((g) => g !== name) }));
}

/** renameGroupLinks — follow a group RENAME in every room. The group name is the
 *  join key between the two stores, so without this a renamed group would be left
 *  as a ghost reference to a name that no longer exists.
 *  @param {Record<string, Room>|null|undefined} rooms @param {string} from @param {string} to
 *  @returns {Record<string, Room>} */
export function renameGroupLinks(rooms, from, to) {
  /** @type {Record<string, Room>} */
  const out = {};
  for (const [symbol, room] of Object.entries(rooms ?? {})) {
    out[symbol] = room.groups?.includes(from)
      ? { ...room, groups: [...new Set(room.groups.map((g) => (g === from ? to : g)))] }
      : room;
  }
  return out;
}

/** dropGroupLinks — remove a DELETED group from every room, so no room keeps
 *  pointing at a group that is gone.
 *  @param {Record<string, Room>|null|undefined} rooms @param {string} name
 *  @returns {Record<string, Room>} */
export function dropGroupLinks(rooms, name) {
  /** @type {Record<string, Room>} */
  const out = {};
  for (const [symbol, room] of Object.entries(rooms ?? {})) {
    out[symbol] = room.groups?.includes(name)
      ? { ...room, groups: room.groups.filter((g) => g !== name) }
      : room;
  }
  return out;
}

/** groupRooms — the symbols a group is linked to (the card's "linked rooms").
 *  @param {Record<string, Room>|null|undefined} rooms @param {string} name
 *  @returns {string[]} */
export function groupRooms(rooms, name) {
  return Object.values(rooms ?? {})
    .filter((r) => r.groups?.includes(name))
    .map((r) => r.symbol)
    .sort();
}

/** strategyUsage — WHO references one strategy id@version: the groups whose
 *  member list carries it and the rooms that have it "in play".
 *
 *  WHY THIS EXISTS: a published artifact is immutable (ADR-009 — the runner
 *  executes exact bytes, and an analysis run pins the version active at run
 *  start), so "editing" it means publishing a NEW version. The thing a trader
 *  actually needs before retiring or re-pinning something is the answer to
 *  "where is this used?": a reference that would break must be visible BEFORE the
 *  action, not discovered afterwards. Same rule as the rest of this file — a
 *  reference is never dropped silently.
 *  @param {Record<string, { name: string, members?: StrategyRef[] }>|null|undefined} groups
 *  @param {Record<string, Room>|null|undefined} rooms
 *  @param {StrategyRef} entry
 *  @returns {{ groups: string[], rooms: string[], total: number }} */
export function strategyUsage(groups, rooms, entry) {
  const key = strategyRefKey(entry);
  const inGroups = Object.values(groups ?? {})
    .filter((g) => (g.members ?? []).some((m) => strategyRefKey(m) === key))
    .map((g) => g.name)
    .sort();
  const inRooms = Object.values(rooms ?? {})
    .filter((r) => (r.strategies ?? []).some((s) => strategyRefKey(s) === key))
    .map((r) => r.symbol)
    .sort();
  return { groups: inGroups, rooms: inRooms, total: inGroups.length + inRooms.length };
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
