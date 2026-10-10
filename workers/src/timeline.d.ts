// Timeline types (TS) — runtime in timeline.mjs.
export interface SignalIn { id: string; watch_id: string; kind: string; payload_json: string; source: string; at: string; }
export interface EventIn { id: string; type: string; entity_id: string; payload_json: string; dedupe_key: string; at: string; }
