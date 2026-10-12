// freshness.mjs — E10-T01-S2: the freshness system (docs/09 §9.2). Pure logic.
//
// Every data widget carries a badge; the rules are normative:
//   LIVE (<5s) green · STALE (>=threshold) amber · CACHED (fallback/last-known)
//   grey · UNAVAILABLE red. No data is NEVER live — an unknown age fails closed
//   to UNAVAILABLE (SAFE-001 at the UI layer). The mode banner is always
//   visible when the system is not PRIMARY, and approve/order actions are
//   disabled with an explicit reason while uncertain (docs/09 §9.4).
export const LIVE_MAX_MS = 5_000;

export const BADGES = /** @type {{ LIVE: BadgeLabel, STALE: BadgeLabel, CACHED: BadgeLabel, UNAVAILABLE: BadgeLabel }} */ ({
  LIVE: "LIVE", STALE: "STALE", CACHED: "CACHED", UNAVAILABLE: "UNAVAILABLE",
});
/** @typedef {"LIVE"|"STALE"|"CACHED"|"UNAVAILABLE"} BadgeLabel */
/** @type {Record<BadgeLabel, string>} */
const TONE = { LIVE: "green", STALE: "amber", CACHED: "grey", UNAVAILABLE: "red" };

/** Derive one badge. `ageMs: null` (or a non-number) is UNAVAILABLE — the UI
 *  must never present unknown data as fresh.
 *  @param {{ ageMs?: number|null, source?: "live"|"cached"|"unavailable" }} [opts]
 *  @returns {{ label: BadgeLabel, tone: string, age_s: number|null }} */
export function badge({ ageMs = null, source = "live" } = {}) {
  /** @type {BadgeLabel} */
  const label = (() => {
    if (source === "unavailable") return BADGES.UNAVAILABLE;
    if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return BADGES.UNAVAILABLE;
    if (source === "cached") return BADGES.CACHED;
    return ageMs < LIVE_MAX_MS ? BADGES.LIVE : BADGES.STALE;
  })();
  return { label, tone: TONE[label], age_s: typeof ageMs === "number" && Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null };
}

/** The global mode banner (docs/09 §9.4): visible whenever mode != PRIMARY, with
 *  the cause and the concrete limitations of this mode — never a bare colour. */
/** @type {Record<string, { text: string, limitations: string[] }>} */
const MODE_INFO = {
  DEGRADED: { text: "DEGRADED — primary plane unhealthy", limitations: ["fallback may engage", "new orders still gated"] },
  FALLBACK: { text: "FALLBACK — serving from the REST poller", limitations: ["prices are polled, not streamed", "orders blocked by default"] },
  HALTED: { text: "HALTED — kill switch engaged", limitations: ["no new orders", "reconcile continues"] },
  D1_DOWN: { text: "D1_DOWN — canonical state unreadable", limitations: ["fail closed for orders", "reads bannered CACHED/STALE"] },
};
/** The global mode banner (docs/09 §9.4).
 *  @param {string} mode
 *  @param {string[]} [reasons]
 *  @returns {{ visible: boolean, mode: string, text: string, limitations: string[], reasons?: string[] }} */
export function modeBanner(mode, reasons = []) {
  if (mode === "PRIMARY") return { visible: false, mode, text: "", limitations: [] };
  const info = MODE_INFO[mode] ?? { text: `${mode} — unknown mode`, limitations: ["fail closed"] };
  return { visible: true, mode, text: info.text, limitations: info.limitations, reasons };
}

/** Why an approve/order action is disabled right now, or null when it may run.
 *  The reason is user-visible verbatim (docs/09 §9.4: "blocked: STALE price (12s)").
 *  @param {{ mode?: string, priceAgeMs?: number|null, priceSource?: "live"|"cached"|"unavailable", killEngaged?: boolean }} [ctx]
 *  @returns {{ blocked: boolean, reason: string } | null} */
export function actionBlocker({ mode = "PRIMARY", priceAgeMs = null, priceSource = "live", killEngaged = false } = {}) {
  if (killEngaged) return { blocked: true, reason: "blocked: kill switch engaged" };
  if (mode === "HALTED") return { blocked: true, reason: "blocked: HALTED — kill switch engaged" };
  if (mode === "D1_DOWN") return { blocked: true, reason: "blocked: D1 DOWN — fail closed for orders" };
  const b = badge({ ageMs: priceAgeMs, source: priceSource });
  if (b.label === BADGES.UNAVAILABLE) return { blocked: true, reason: "blocked: UNAVAILABLE price" };
  if (b.label === BADGES.STALE) return { blocked: true, reason: `blocked: STALE price (${b.age_s}s)` };
  if (mode === "DEGRADED" || mode === "FALLBACK") return { blocked: true, reason: `blocked: ${mode}` };
  return null;
}

/** Approval countdown (docs/09 §9.1 /approvals): live seconds until expiry.
 *  @param {string} expires_at
 *  @param {number} [nowMs]
 *  @returns {{ valid: boolean, seconds_left: number|null, text: string, expired: boolean }} */
export function countdown(expires_at, nowMs = Date.now()) {
  const exp = Date.parse(expires_at ?? "");
  if (!Number.isFinite(exp)) return { valid: false, seconds_left: null, text: "unknown", expired: true };
  const ms = exp - nowMs;
  const seconds_left = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(seconds_left / 60);
  const ss = seconds_left % 60;
  return { valid: true, seconds_left, expired: ms <= 0, text: ms <= 0 ? "expired" : `${mm}:${String(ss).padStart(2, "0")}` };
}

/** A timeline never interpolates (docs/09 §9.4): gaps between entries are shown
 *  as explicit gap markers, not bridged.
 *  @param {{ at?: string, kind?: string, type?: string }[]} [entries]
 *  @param {{ gapMs?: number, nowMs?: number }} [opts]
 *  @returns {({ kind: string } & Record<string, unknown>)[]} */
export function timeline(entries, { gapMs = 30_000, nowMs = Date.now() } = {}) {
  const rows = [];
  /** @param {{ at?: string }} e */
  const ts = (e) => Date.parse(e?.at ?? "");
  const sorted = [...(entries ?? [])].filter((e) => Number.isFinite(ts(e))).sort((a, b) => ts(a) - ts(b));
  let prev = null;
  for (const e of sorted) {
    if (prev !== null && ts(e) - prev > gapMs) {
      rows.push({ kind: "gap", from: new Date(prev).toISOString(), to: new Date(ts(e)).toISOString(), seconds: Math.round((ts(e) - prev) / 1000) });
    }
    rows.push({ kind: "entry", ...e });
    prev = ts(e);
  }
  if (sorted.length) {
    const last = sorted[sorted.length - 1];
    if (nowMs - ts(last) > gapMs) {
      rows.push({ kind: "gap", from: last.at, to: new Date(nowMs).toISOString(), seconds: Math.round((nowMs - ts(last)) / 1000), open: true });
    }
  }
  return rows;
}