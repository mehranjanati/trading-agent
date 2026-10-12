// loaders.ts — E10-T01: SvelteKit load functions. They run on the SERVER (SSR)
// and again on hydration, so the first paint already carries real data and a
// real badge — a fallback visit shows the banner + STALE/CACHED immediately,
// not after hydration. Every loader returns { result } and nothing else.
import { getHealth, getWatches, getSignals, getAnalysis, getApprovals, getIntents, getPositions, getRecoveryLog, getStrategies } from "./api";

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