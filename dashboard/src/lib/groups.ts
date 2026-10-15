// groups.ts — client-side strategy groups (localStorage until backend migration).
//
// A group bundles library strategies into ONE advisory output for ONE job
// (entry / confirmation / exit-scan). Groups are advisory metadata only: the
// execution path (analyze → StalkSetup → watch) still pins individual
// strategy id@version rows. Labelled `advisory-group` in the UI so nobody
// mistakes the bundle for a built composite WASM artifact.
import { writable } from "svelte/store";

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

export function deleteGroup(name: string): void {
  groups.update((all) => {
    const next = { ...all };
    delete next[name];
    return next;
  });
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
