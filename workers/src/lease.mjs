// lease.mjs — E05-T02-S1: ExecutionAuthority DO state machine (fencing by epoch).
// Pure logic + storage interface; the DO runtime (index) wraps it with storage API.
// Rules (ADR-003): TTL 30s, renew 10s, monotonic epoch, single holder globally.
export const TTL_MS = 30_000;
export const RENEW_MS = 10_000;

export function createAuthority(storage) {
  const load = () => JSON.parse(storage.get("lease") ?? "null"); // {holder,epoch,expires_ms}
  const save = (l) => storage.set("lease", JSON.stringify(l));
  return {
    load,
    /** acquire: holder wins if free or expired; epoch = last+1 (monotonic). */
    acquire(holder, nowMs) {
      const cur = load();
      if (cur && cur.expires_ms > nowMs && cur.holder !== holder) {
        return { ok: false, held_by: cur.holder, epoch: cur.epoch, reason: "held" };
      }
      const epoch = (cur?.epoch ?? 0) + 1;
      const lease = { holder, epoch, expires_ms: nowMs + TTL_MS };
      save(lease);
      return { ok: true, ...lease };
    },
    /** renew: only the current holder with the current epoch, and not yet expired. */
    renew(holder, epoch, nowMs) {
      const cur = load();
      if (!cur || cur.holder !== holder) return { ok: false, reason: "not-holder" };
      if (cur.epoch !== epoch) return { ok: false, reason: "stale-epoch" };
      if (cur.expires_ms <= nowMs) return { ok: false, reason: "expired" };
      const lease = { holder, epoch, expires_ms: nowMs + TTL_MS };
      save(lease);
      return { ok: true, ...lease };
    },
    /** verify: fencing token check — every submit MUST pass this. */
    verify(holder, epoch, nowMs) {
      const cur = load();
      if (!cur) return { ok: false, reason: "no-lease" };
      if (cur.holder !== holder || cur.epoch !== epoch) {
        return { ok: false, reason: "fenced", current: cur }; // lease.fenced event
      }
      if (cur.expires_ms <= nowMs) return { ok: false, reason: "expired" };
      return { ok: true, ...cur };
    },
    /** release: explicit handoff; epoch bump on next acquire prevents zombie holders. */
    release(holder, epoch) {
      const cur = load();
      if (!cur || cur.holder !== holder || cur.epoch !== epoch) return { ok: false, reason: "fenced" };
      storage.set("lease", "null");
      return { ok: true };
    },
  };
}
