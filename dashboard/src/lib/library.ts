// library.ts — the unified strategy catalog for pickers.
//
// Sources, in priority order:
//   1. Go registry (pinned WASM: id@version + sha, the execution truth)
//   2. AI drafts (review-only code, selectable for future builds)
//
// Until the Go registry endpoint ships, PINNED mirrors
// go-watcher/strategies/samples/registry.json — a single constant to update,
// not scattered literals. Every picker (groups, setups, analyze) reads from
// here so the catalog is identical everywhere.
export interface LibraryEntry {
  id: string;
  version: string;
  kind: "pinned" | "draft";
  label: string;
  blurb: string;
  draftId?: string;
}

/** Mirrors go-watcher/strategies/samples/registry.json — update both together. */
export const PINNED_REGISTRY: { id: string; version: string; name: string; blurb: string }[] = [
  { id: "sma-cross", version: "0.1.0", name: "SMA Cross (fast)", blurb: "fast 2 / slow 3 — golden fixture" },
  { id: "sma-cross", version: "0.2.0", name: "SMA Cross (slow)", blurb: "fast 5 / slow 20" },
  { id: "sma-x-live", version: "0.1.0", name: "SMA-X Live", blurb: "fast 5 / slow 20" },
  { id: "sma-x-v2", version: "0.1.0", name: "SMA-X v2", blurb: "fast 5 / slow 20" },
];

export function catalogFromDrafts(
  drafts: { id: string; strategy_id: string; version: string; status: string }[],
): LibraryEntry[] {
  const pinned: LibraryEntry[] = PINNED_REGISTRY.map((p) => ({
    id: p.id, version: p.version, kind: "pinned" as const,
    label: `${p.id}@${p.version}`, blurb: `${p.name} — ${p.blurb}`,
  }));
  const seen = new Set(pinned.map((p) => `${p.id}@${p.version}`));
  const fromDrafts: LibraryEntry[] = [];
  for (const d of drafts ?? []) {
    const key = `${d.strategy_id}@${d.version}`;
    if (seen.has(key)) continue; // a built draft graduates to pinned — no dupes
    seen.add(key);
    fromDrafts.push({
      id: d.strategy_id, version: d.version, kind: "draft" as const,
      label: key, blurb: `draft ${d.status}`, draftId: d.id,
    });
  }
  return [...pinned, ...fromDrafts];
}

export const entryKey = (id: string, version?: string) => `${id}@${version ?? "latest"}`;
