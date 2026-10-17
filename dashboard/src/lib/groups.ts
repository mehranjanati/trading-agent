// groups.ts — client-side strategy groups (localStorage until backend migration).
//
// A group bundles library strategies into ONE advisory output for ONE job
// (entry / confirmation / exit-scan). Groups are advisory metadata only: the
// execution path (analyze → StalkSetup → watch) still pins individual
// strategy id@version rows. Labelled `advisory-group` in the UI so nobody
// mistakes the bundle for a built composite WASM artifact.
import { writable, get } from "svelte/store";
import { setups } from "./setups";
import { renameGroupLinks, dropGroupLinks, groupRooms } from "./setups-core.mjs";

export type GroupJob = "entry" | "confirmation" | "exit-scan";

export interface StrategyGroup {
  name: string;
  members: { id: string; version?: string; weight?: number }[];
  job: GroupJob;
  createdAt: string;
}

const LS_KEY = "ta_strategy_groups_v1";

function load(): Record<string, StrategyGroup> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, StrategyGroup>;
  } catch { /* fresh start */ }
  return {};
}

export const groups = writable<Record<string, StrategyGroup>>(
  typeof localStorage !== "undefined" ? load() : {},
);

groups.subscribe((v) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, JSON.stringify(v));
  } catch { /* in-memory still works */ }
});

export function saveGroup(g: StrategyGroup): void {
  groups.update((all) => ({ ...all, [g.name]: { ...g, createdAt: g.createdAt ?? new Date().toISOString() } }));
}

/** renameGroup — rename a saved group AND follow the rename in every room that
 *  linked it (the group name is the join key between the two stores, so a bare
 *  rename would leave ghost references behind).
 *
 *  Returns false when there is nothing to rename, the name is unchanged, or the
 *  target name already belongs to another group — a rename never silently
 *  overwrites a sibling. */
export function renameGroup(from: string, to: string): boolean {
  const oldName = String(from ?? "").trim();
  const newName = String(to ?? "").trim();
  if (!oldName || !newName || oldName === newName) return false;
  const all = get(groups);
  if (!all[oldName] || all[newName]) return false;
  const next = { ...all };
  next[newName] = { ...all[oldName], name: newName };
  delete next[oldName];
  groups.set(next);
  setups.update((rooms) => renameGroupLinks(rooms, oldName, newName));
  return true;
}

/** deleteGroup — remove a saved group and unlink it from every room. Returns the
 *  symbols it was linked to (the caller reports them, so a delete is never
 *  silent about what it cleaned up). */
export function deleteGroup(name: string): string[] {
  const key = String(name ?? "").trim();
  if (!key) return [];
  const linked = groupRooms(get(setups), key);
  groups.update((all) => {
    const next = { ...all };
    delete next[key];
    return next;
  });
  if (linked.length) setups.update((rooms) => dropGroupLinks(rooms, key));
  return linked;
}

export function toggleMember(
  members: { id: string; version?: string }[],
  entry: { id: string; version?: string },
): { id: string; version?: string }[] {
  const key = (m: { id: string; version?: string }) => `${m.id}@${m.version ?? "latest"}`;
  const k = key(entry);
  if (members.some((m) => key(m) === k)) return members.filter((m) => key(m) !== k);
  return [...members, { id: entry.id, version: entry.version }];
}
