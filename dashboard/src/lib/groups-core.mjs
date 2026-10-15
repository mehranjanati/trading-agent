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
