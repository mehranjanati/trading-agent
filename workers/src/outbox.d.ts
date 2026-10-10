// Outbox types (TS) — runtime in outbox.mjs (dependency-free).
export interface OutboxRow {
  id: string; aggregate: string; payload_json: string;
  claimed_by: string | null; attempts: number; next_retry: string | null; done: number;
}
export interface RelayTarget { publish(row: OutboxRow): Promise<void>; }
