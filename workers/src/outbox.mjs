// outbox.mjs — E04-T01-S2: transactional outbox relay (Workers).
// Batch rule: business row + outbox row commit atomically in D1; relay publishes
// afterwards. Consumers dedupe on dedupe_key. Kill-mid-publish redelivers safely.
// TS types live in outbox.d.ts; runtime here is dependency-free Node.
export const MAX_ATTEMPTS = 10;
export function backoffMs(attempt) {
  return Math.min(5 * 60 * 1000, 1000 * 2 ** attempt);
}
// Due-row filter (runs on D1 in E05; pure string here for testability).
export function dueFilterSql(nowIso) {
  return `done = 0 AND attempts < ${MAX_ATTEMPTS} AND (next_retry IS NULL OR next_retry <= '${nowIso}')`;
}
export async function relayOnce(rows, target, markDone, defer, now = new Date()) {
  let done = 0, deferred = 0, dlq = 0;
  for (const row of rows) {
    if (row.attempts >= MAX_ATTEMPTS) { dlq++; continue; } // alert path in E06
    try {
      await target.publish(row);
      await markDone(row.id);
      done++;
    } catch {
      const next = new Date(now.getTime() + backoffMs(row.attempts)).toISOString();
      await defer(row.id, next);
      deferred++;
    }
  }
  return { done, deferred, dlq };
}
