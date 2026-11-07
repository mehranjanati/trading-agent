// loaders.ts — E10-T01: SvelteKit load functions. They run on the SERVER (SSR)
// and again on hydration, so the first paint already carries real data and a
// real badge — a fallback visit shows the banner + STALE/CACHED immediately,
// not after hydration. Every loader returns `{ result }` and nothing else
// (the multi-widget loaders below return one entry per widget).
import { getHealth, getWatches, getWatchesAll, getSignals, getAnalysis, getApprovals, getIntents, getPositions, getRecoveryLog, getStrategies } from "./api";
import { getSymbols } from "./symbols";

export const loadHealth = async () => ({ result: await getHealth() });
export const loadWatches = async () => ({ result: await getWatches() });
export const loadSignals = async () => ({ result: await getSignals() });
export const loadAnalysis = async () => ({ result: await getAnalysis() });
export const loadApprovals = async () => ({ result: await getApprovals() });
export const loadIntents = async () => ({ result: await getIntents() });
export const loadPositions = async () => ({ result: await getPositions() });
export const loadRecovery = async () => ({ result: await getRecoveryLog(200) });
export const loadStrategies = async () => ({ result: await getStrategies() });
/** /orders needs intents AND positions in one load (one round trip each). */
export const loadOrders = async () => ({ result: await getIntents(), positions: await getPositions() });

/** /cockpit (docs/20, E15-T01): the desk's initial snapshot — one round trip
 *  each, in parallel, so SSR paints the sidebar and the watch board without a
 *  client-only blank. The page refreshes on its own interval afterwards; symbols
 *  carry their own staleness flag. `health` rides along because the cockpit's
 *  header replaces the old `/` overview: the component strip (go / redis /
 *  workers / d1 / lease) must stay visible somewhere.
 *
 *  NO PRICES HERE (ADR-004): the quote is for the SELECTED symbol, and that
 *  selection is derived client-side from the board this response builds. Asking
 *  the venue for the whole market list during SSR painted one number with ~1000
 *  rows, so the cockpit fetches `getPrices([symbol])` itself once it knows what
 *  is selected. `snap.prices` is simply absent until then and every reader
 *  already treats a missing result as "no price". */
export const loadCockpit = async () => {
  const [health, symbols, watches, approvals, intents, positions] = await Promise.all([
    getHealth(),
    getSymbols(),
    getWatchesAll(),
    getApprovals(),
    getIntents(),
    getPositions(),
  ]);
  return { cockpit: { health, symbols, watches, approvals, intents, positions } };
};

/** /execution (docs/20 §20.2): approvals queue + intents + positions — the
 *  money view. One round trip each, in parallel. */
export const loadExecution = async () => {
  const [approvals, result, positions] = await Promise.all([getApprovals(), getIntents(), getPositions()]);
  return { approvals, result, positions };
};

/** /activity (docs/20 §20.2): the four timelines over signals + recovery_log. */
export const loadActivity = async () => {
  const [signals, incidents] = await Promise.all([getSignals(), getRecoveryLog(200)]);
  return { signals, incidents };
};