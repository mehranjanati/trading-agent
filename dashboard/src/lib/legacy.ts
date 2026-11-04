// legacy.ts — the docs/20 §20.5 redirect, as a SvelteKit load function.
//
// One implementation for every legacy route: the RULE lives in
// cockpit-core.mjs (tested), this file only turns it into a 302. A path the map
// does not own returns `{}` and its page renders exactly as before — which is
// what lets the consolidation ship slice-by-slice instead of at once.
import { redirect } from "@sveltejs/kit";
import { legacyRedirect } from "./cockpit-core.mjs";

/** legacyLoad — 302 to the cockpit/execution/activity URL when the map owns the
 *  path, otherwise let the page render normally. */
export function legacyLoad({ url }: { url: URL }) {
  const to = legacyRedirect(url.pathname, url.search);
  if (to) throw redirect(302, to);
  return {};
}
