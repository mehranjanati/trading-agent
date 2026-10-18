// groups-core.mjs — pure save-group logic: no Svelte, no DOM, no storage.
//
// WHY .mjs AND NOT INSIDE THE COMPONENT: the same reason freshness.mjs exists —
// `node --test` imports the REAL implementation instead of a hand-copied mirror,
// so the validation the button runs is the validation under test.
//
// Regression this pins: the `save group` button used to be `disabled` whenever
// the form was incomplete, which made it silent (the click never reached the
// handler and its alerts were dead code). Validation therefore lives here and is
// ALWAYS run by the click handler — never expressed as a disabled attribute.

/** groupValidationError returns the message to show when the draft group cannot
 *  be saved, or null when it can. Name is checked first so an untouched form
 *  reports the name rather than the members.
 *  @param {unknown} name
 *  @param {unknown[]|null|undefined} members
 *  @returns {string|null} */
export function groupValidationError(name, members) {
  if (!String(name ?? "").trim()) return "لطفاً نام گروهی وارد کنید";
  if (!Array.isArray(members) || members.length === 0) return "حداقل یک استراتژی را تیک بزنید";
  return null;
}

/** groupMembers maps picked library entries to the stored member shape.
 *  @param {{ id: string, version?: string }[]|null|undefined} entries
 *  @returns {{ id: string, version?: string }[]} */
export function groupMembers(entries) {
  return (entries ?? []).map((e) => ({ id: e.id, version: e.version }));
}

/** groupStatusText is the live hint under the button: the last action result
 *  when there is one, otherwise what the form still needs.
 *  @param {string} groupNote
 *  @param {unknown} name
 *  @param {number} memberCount
 *  @returns {string} */
export function groupStatusText(groupNote, name, memberCount) {
  if (groupNote) return groupNote;
  if (!String(name ?? "").trim()) return "enter a group name";
  if (memberCount === 0) return "tick at least one strategy";
  return `ready to save — ${memberCount} ${memberCount === 1 ? "strategy" : "strategies"}`;
}

// ── Editing an EXISTING group ────────────────────────────────────────────────
//
// Regression this pins: a saved group was frozen. The card listed its members
// and offered a bare `delete group`; there was no way to rename it, change its
// job, add or remove a member — and deleting it left every room that linked it
// pointing at a name that no longer existed. Groups are the trader's own
// selection (advisory localStorage), so all of that has to be editable.

/** groupMemberKey — the identity a group's member list dedupes on (the same
 *  id@version rule as the pickers).
 *  @param {{ id: string, version?: string }} m
 *  @returns {string} */
export function groupMemberKey(m) {
  return `${m?.id}@${m?.version ?? "latest"}`;
}

/** groupEditRows — the tick-list for editing a group: every current library
 *  entry, PLUS one row per stored member the library no longer carries (a draft
 *  that was deleted, a version the registry stopped pinning). Those rows must
 *  stay VISIBLE: rebuilding the member list from the library alone would drop
 *  them silently — the trader would lose a member by opening the editor.
 *  @param {{ id: string, version?: string, kind?: string, label?: string, blurb?: string, status?: string }[]|null|undefined} catalog
 *  @param {{ id: string, version?: string }[]|null|undefined} members
 *  @returns {{ id: string, version?: string, kind: string, label: string, blurb: string, status?: string, selectable: boolean }[]} */
export function groupEditRows(catalog, members) {
  // `selectable: false` = a RETIRED version (ADR-011): it stays visible and an
  // existing member stays editable, but it cannot be ADDED to a new group.
  const rows = (catalog ?? []).map((e) => ({
    ...e, kind: e.kind ?? "pinned", label: e.label ?? groupMemberKey(e), blurb: e.blurb ?? "",
    selectable: e.status !== "retired",
  }));
  const have = new Set(rows.map((e) => groupMemberKey(e)));
  for (const m of members ?? []) {
    const k = groupMemberKey(m);
    if (have.has(k)) continue;
    have.add(k);
    rows.push({ id: m.id, version: m.version, kind: "missing", label: k, blurb: "not in the current library — kept unless you untick it", selectable: true });
  }
  return rows;
}

/** groupEditError — what still blocks a group edit, or null when it can be
 *  saved. `taken` is the set of OTHER group names (renaming onto a sibling must
 *  be refused, never a silent overwrite).
 *  @param {unknown} name
 *  @param {number} memberCount
 *  @param {string} currentName
 *  @param {string[]} taken
 *  @returns {string|null} */
export function groupEditError(name, memberCount, currentName, taken) {
  const n = String(name ?? "").trim();
  if (!n) return "لطفاً نام گروهی وارد کنید";
  if (n !== currentName && (taken ?? []).includes(n)) return `گروه «${n}» از قبل وجود دارد — نام دیگری انتخاب کنید`;
  if (memberCount === 0) return "حداقل یک استراتژی را تیک بزنید";
  return null;
}

/** groupEditNote — the answer the edit form shows after a save.
 *  @param {string} name
 *  @param {number} memberCount
 *  @param {string} previousName
 *  @returns {string} */
export function groupEditNote(name, memberCount, previousName) {
  const renamed = previousName && previousName !== name ? ` (نام قبلی «${previousName}» در اتاقها هم بهروز شد)` : "";
  return `گروه «${name}» بهروزرسانی شد — ${memberCount} استراتژی${renamed}`;
}

/** groupDeleteNote — the answer after a delete (never silent: the rooms that
 *  linked the group are unlinked in the same action).
 *  @param {string} name
 *  @param {string[]} rooms
 *  @returns {string} */
export function groupDeleteNote(name, rooms) {
  const linked = (rooms ?? []).length
    ? ` و از ${rooms.length} اتاق (${rooms.join(", ")}) هم برداشته شد`
    : "";
  return `گروه «${name}» حذف شد${linked}`;
}

