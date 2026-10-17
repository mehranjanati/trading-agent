// lease.mjs — E05-T02-S1: ExecutionAuthority DO state machine (fencing by epoch).
// Pure logic + storage interface; the DO runtime (index) wraps it with storage API.
// Rules (ADR-003): TTL 120s, renew each cron tick, monotonic epoch, single holder globally.
// WHY 120s (was 30s): the deployed cron cadence is 1/minute (Cloudflare 5-field
// minimum — wrangler.toml [triggers]), so a 30s lease EXPIRES between ticks and
// the §6.3 rejoin gate can never see lease_ours=true (permanent lease_expired).
// 120s = 2 missed ticks of grace; fencing semantics (epoch) are unchanged —
// a zombie holder with a superseded epoch is still rejected as stale-epoch.
export const TTL_MS = 120_000;
export const RENEW_MS = 10_000;

/** Authority holders (ADR-003): the primary plane and the Workers fallback plane. */
export const HOLDERS = { PRIMARY: "primary", FALLBACK: "workers-fallback" };

/** E06-T02-S3b: does `holder` still hold authority at `nowMs`? A missing record is
 *  "nobody", never "us" — the rejoin gate (§6.3 condition 4) must fail closed. */
export function holdsAuthority(lease, holder, nowMs) {
  if (!lease || lease.holder !== holder) return false;
  return Number(lease.expires_ms) > nowMs;
}

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
    /** renew: only the current holder with the current epoch, and not yet expired.
     *  The epoch is checked FIRST because it is the fencing token (§6.3): a caller
     *  presenting a superseded epoch is reported as `stale-epoch` whatever its holder,
     *  which is the signal the `lease.fenced` alert path keys on. */
    renew(holder, epoch, nowMs) {
      const cur = load();
      if (!cur) return { ok: false, reason: "not-holder" };
      if (cur.epoch !== epoch) return { ok: false, reason: "stale-epoch" };
      if (cur.holder !== holder) return { ok: false, reason: "not-holder" };
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
    /** release: explicit handoff. The epoch counter is KEPT (holder cleared, expiry 0)
     *  so the next acquire is strictly monotonic — a zombie holder can never re-use the
     *  epoch it was fenced with (§6.3 "lease handoff with epoch bump", ADR-003). */
    release(holder, epoch) {
      const cur = load();
      if (!cur || cur.holder !== holder || cur.epoch !== epoch) return { ok: false, reason: "fenced" };
      save({ holder: null, epoch: cur.epoch, expires_ms: 0 });
      return { ok: true };
    },
  };
}
