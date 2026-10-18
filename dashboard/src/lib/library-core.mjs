// library-core.mjs — the pure strategy-catalog composition: no Svelte, no DOM,
// no fetch. `node --test` imports the REAL implementation (the freshness.mjs /
// groups-core.mjs pattern), so the catalog the pickers render is the catalog
// under test.
//
// SOURCES, in priority order:
//   1. Go registry — GET {GO_BASE}/strategies/registry (registry_endpoint.go).
//      The Go plane owns the pinned .wasm bytes, so this is the only truthful
//      list: a version that appears here is one the runner can execute, with
//      the sha256 it will execute.
//   2. AI drafts — review-only code, selectable for future builds.
//
// PINNED_FALLBACK is NOT a source of truth. It exists for the degraded case
// (the Go plane lives on Hetzner and a Pages browser may not reach it) so the
// library tab still renders instead of going blank. `composeCatalog` reports
// which path it took so the UI can label it — a stale pin must never look live.

/**
 * @typedef {{ id: string, version: string, kind: "pinned"|"draft", label: string, blurb: string,
 *             sha256?: string, configuration?: Record<string, unknown>, draftId?: string,
 *             status?: "active"|"retired", retired_reason?: string }} LibraryEntry
 */

/** Offline fallback mirroring go-watcher/strategies/samples/registry.json. */
export const PINNED_FALLBACK = [
  { id: "sma-cross", version: "0.1.0", name: "SMA Cross (fast)", description: "fast 2 / slow 3 — golden fixture" },
  { id: "sma-cross", version: "0.2.0", name: "SMA Cross (slow)", description: "fast 5 / slow 20" },
  { id: "sma-x-live", version: "0.1.0", name: "SMA-X Live", description: "fast 5 / slow 20" },
  { id: "sma-x-v2", version: "0.1.0", name: "SMA-X v2", description: "fast 5 / slow 20" },
];

/** entryKey is the identity every picker dedupes on.
 *  @param {string} id
 *  @param {string} [version]
 *  @returns {string} */
export const entryKey = (id, version) => `${id}@${version ?? "latest"}`;

/** pinnedEntry maps one registry row to a library entry. `sha256` rides along
 *  when the endpoint supplied it, so the UI can show the exact artifact.
 *  `status` (ADR-011) rides along too: a RETIRED version is still executable for
 *  references already in flight, but it must not be offered for new work — the
 *  pickers filter it out and the library tab labels it.
 *  @param {{ id: string, version: string, name?: string, description?: string, sha256?: string, configuration?: Record<string, unknown>, status?: string, retired_reason?: string }} p
 *  @returns {LibraryEntry} */
export function pinnedEntry(p) {
  const retired = p.status === "retired";
  return {
    id: p.id,
    version: p.version,
    kind: "pinned",
    label: entryKey(p.id, p.version),
    blurb: [p.name, p.description].filter(Boolean).join(" — ") || "pinned wasm",
    sha256: p.sha256 || undefined,
    configuration: p.configuration ?? {},
    status: retired ? "retired" : "active",
    ...(retired && p.retired_reason ? { retired_reason: p.retired_reason } : {}),
  };
}

/** isRetired — true for a retired pinned version (see ADR-011). A draft is never
 *  "retired": drafts are review-only and are discarded explicitly instead.
 *  @param {{ status?: string }|null|undefined} e
 *  @returns {boolean} */
export function isRetired(e) {
  return e?.status === "retired";
}

/** selectableCatalog — the entries a NEW selection may draw from: everything
 *  except retired pinned versions. The library still LISTS retired ones (a group
 *  may pin one, and the trader must see why it is not offered).
 *  @param {LibraryEntry[]|null|undefined} catalog
 *  @returns {LibraryEntry[]} */
export function selectableCatalog(catalog) {
  return (catalog ?? []).filter((e) => !isRetired(e));
}

/** draftEntry maps one D1 draft row to a library entry.
 *  @param {{ id: string, strategy_id: string, version: string, status: string }} d
 *  @returns {LibraryEntry} */
export function draftEntry(d) {
  return {
    id: d.strategy_id,
    version: d.version,
    kind: "draft",
    label: entryKey(d.strategy_id, d.version),
    blurb: `draft ${d.status}`,
    draftId: d.id,
  };
}

/** composeCatalog merges the pinned catalog with the drafts, dropping a draft
 *  whose id@version is already pinned (a built draft graduates to pinned — no
 *  dupes). `pinned: null` (or an empty list) means the Go registry was
 *  unreachable or empty, and the caller must surface `source: "fallback"`.
 *
 *  @param {{ id: string, version: string, name?: string, description?: string, sha256?: string, configuration?: Record<string, unknown> }[]|null|undefined} pinned
 *  @param {{ id: string, strategy_id: string, version: string, status: string }[]|null|undefined} drafts
 *  @returns {{ entries: LibraryEntry[], source: "registry"|"fallback" }} */
export function composeCatalog(pinned, drafts) {
  const live = Array.isArray(pinned) && pinned.length > 0;
  const rows = live ? pinned : PINNED_FALLBACK;
  const entries = rows.map(pinnedEntry);

  const seen = new Set(entries.map((e) => e.label));
  for (const d of drafts ?? []) {
    const key = entryKey(d.strategy_id, d.version);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(draftEntry(d));
  }
  return { entries, source: live ? "registry" : "fallback" };
}
