// setups.ts — per-symbol setup rooms (Svelte store + localStorage persist).
//
// A setup room is the trader's unit of work: one symbol → its chat session,
// strategies/groups in play, analyses, watches, and derived status. The
// canonical trading state stays in D1 (watches/orders/positions via the API);
// this store holds only the ADVISORY linkage (which chat/strategies belong to
// which symbol) until the backend setup migration lands.
//
// The ROOM LOGIC (which watches belong to a symbol, what that makes the room's
// status) lives in setups-core.mjs so `node --test` imports the real
// implementation instead of a hand-copied mirror — the freshness.mjs /
// groups-core.mjs / library-core.mjs pattern.
import { writable, get } from "svelte/store";
import { linkStrategy, unlinkStrategy, linkGroup, unlinkGroup, groupRooms } from "./setups-core.mjs";

export type SetupStatus = "OPEN" | "STALKING" | "AWAITING-APPROVAL" | "IDLE";

/** One watch row as the room reads it (see setups-core.mjs roomWatches). */
export interface RoomWatch {
  id: string;
  symbol: string;
  status: string;
  direction?: string;
  version?: number;
  updated_at?: string;
}

export { deriveStatus, roomWatches, roomWatchIds } from "./setups-core.mjs";
export { linkStrategy, unlinkStrategy, linkGroup, unlinkGroup, groupRooms, strategyRefKey, strategyUsage } from "./setups-core.mjs";

export interface SymbolSetup {
  symbol: string;
  chatSession: string | null;
  strategies: { id: string; version?: string }[];
  groups: string[];
  analyzes: string[];
  watches: string[];
  updatedAt: string;
}

const LS_KEY = "ta_setups_v1";
export const chatSessionKey = (symbol: string) => `chat_session_${symbol}`;

function load(): Record<string, SymbolSetup> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, SymbolSetup>;
  } catch { /* fresh start */ }
  return {};
}

function persist(v: Record<string, SymbolSetup>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(v));
  } catch { /* storage full/blocked — in-memory still works */ }
}

function blank(symbol: string): SymbolSetup {
  return { symbol, chatSession: null, strategies: [], groups: [], analyzes: [], watches: [], updatedAt: new Date().toISOString() };
}

export const setups = writable<Record<string, SymbolSetup>>(
  typeof localStorage !== "undefined" ? load() : {},
);

setups.subscribe((v) => {
  if (typeof localStorage !== "undefined") persist(v);
});

export function touchSetup(symbol: string, patch: Partial<SymbolSetup>): void {
  setups.update((all) => {
    const cur = all[symbol] ?? blank(symbol);
    return { ...all, [symbol]: { ...cur, ...patch, symbol, updatedAt: new Date().toISOString() } };
  });
}

// ── Room links: link/unlink a strategy or a group on ONE symbol ───────────────
// These are the mutations the room page and the strategies page share. Advisory
// linkage only (localStorage) — the canonical watch/order state stays in D1.
// Each is idempotent, and the group link is a TOGGLE because a one-way link was
// the bug: a group could be linked from /strategies and never removed.

/** linkStrategyTo — put one id@version in a room's "strategies in play". */
export function linkStrategyTo(symbol: string, entry: { id: string; version?: string }): void {
  setups.update((rooms) => linkStrategy(rooms, symbol, entry));
}

/** unlinkStrategyFrom — take one id@version out of a room. */
export function unlinkStrategyFrom(symbol: string, entry: { id: string; version?: string }): void {
  setups.update((rooms) => unlinkStrategy(rooms, symbol, entry));
}

/** toggleGroupLink — link the group to the symbol, or unlink it when it is
 *  already linked. Returns the state AFTER the toggle (true = linked). */
export function toggleGroupLink(symbol: string, name: string): boolean {
  const key = String(symbol ?? "").trim().toUpperCase();
  const linked = (get(setups)[key]?.groups ?? []).includes(name);
  setups.update((rooms) => (linked ? unlinkGroup(rooms, key, name) : linkGroup(rooms, key, name)));
  return !linked;
}
