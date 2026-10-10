// Watch repo types (TS) — runtime in watches.mjs.
export type WatchStatus = "DRAFT"|"ACTIVE"|"TRIGGERED"|"ANALYZED"|"APPROVED"|"ORDERED"|"INVALIDATED"|"EXPIRED"|"CLOSED";
export interface TransitionMeta { tid: string; reason: string; actor: string; at: string; }
