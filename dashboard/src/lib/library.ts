// library.ts — the unified strategy catalog for pickers (typed surface).
//
// The composition itself lives in library-core.mjs so `node --test` imports the
// real implementation instead of a hand-copied mirror. Read that file for the
// source-of-truth rules: the Go registry endpoint
// (GET {GO_BASE}/strategies/registry) is the source; PINNED_FALLBACK is only the
// offline mirror used when the Go plane is unreachable.
export interface LibraryEntry {
  id: string;
  version: string;
  kind: "pinned" | "draft";
  label: string;
  blurb: string;
  /** Pinned only: the artifact hash the runner will execute. */
  sha256?: string;
  /** Pinned only: the baseline configuration the runner merges. */
  configuration?: Record<string, unknown>;
  draftId?: string;
}

export type CatalogSource = "registry" | "fallback";

export interface LibraryCatalog {
  entries: LibraryEntry[];
  source: CatalogSource;
}

export { PINNED_FALLBACK, entryKey, composeCatalog, pinnedEntry, draftEntry } from "./library-core.mjs";
