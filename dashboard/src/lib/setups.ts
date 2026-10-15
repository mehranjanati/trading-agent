// setups.ts — per-symbol setup rooms (Svelte store + localStorage persist).
//
// A setup room is the trader's unit of work: one symbol → its chat session,
// strategies/groups in play, analyses, watches, and derived status. The
// canonical trading state stays in D1 (watches/orders/positions via the API);
// this store holds only the ADVISORY linkage (which chat/strategies belong to
// which symbol) until the backend setup migration lands.
import { writable } from "svelte/store";

export type SetupStatus = "OPEN" | "STALKING" | "AWAITING-APPROVAL" | "IDLE";

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

/** Derive one symbol's room status from live API snapshots (no new endpoints). */
export function deriveStatus(symbol: string, snap: {
  positions: { symbol: string; size: string }[];
  watches: { symbol: string; status: string }[];
  approvals: { watch_id: string; used_at: string | null; expires_at: string }[];
  watchIds: string[];
}): SetupStatus {
  const pos = snap.positions.find((p) => p.symbol === symbol);
  if (pos && pos.size !== "0" && pos.size !== "") return "OPEN";
  const now = Date.now();
  const awaiting = snap.approvals.some(
    (a) => snap.watchIds.includes(a.watch_id) && !a.used_at && Date.parse(a.expires_at) > now,
  );
  if (awaiting) return "AWAITING-APPROVAL";
  if (snap.watches.some((w) => w.symbol === symbol && w.status === "ACTIVE")) return "STALKING";
  return "IDLE";
}
