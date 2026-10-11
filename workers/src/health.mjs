// health.mjs — E06-T01-S1: health evaluator + mode derivation (pure, testable).
// Thresholds per docs/06 §6.1: heartbeat 5s cadence, UNHEALTHY after 3 misses (15s),
// stream lag >30s = LAG, price stale per Q-04 (majors 5s / alts 10s), lease TTL 30s.
// Modes: PRIMARY | DEGRADED | FALLBACK | HALTED | D1_DOWN (badge colors in §09.2).

export const TH = {
  HEARTBEAT_MS: 5_000,
  MISSES: 3,
  STREAM_LAG_MS: 30_000,
  LEASE_TTL_MS: 30_000,
  PRICE_STALE_MS: 5_000,
  RECOVER_CONTIG_MS: 60_000, // return-to-primary: Go healthy 60s continuous
};

/** Signals captured once per cron tick (10s). Missing fields treated as worst-case. */
export function evaluate(sig, killEngaged = false) {
  const reasons = [];
  if (killEngaged) {
    return { mode: "HALTED", reasons: ["kill_switch_engaged"], components: componentRows(sig, true) };
  }
  const goStaleMs = sig.now_ms - (sig.go_heartbeat_ms ?? 0);
  const goHealthy = sig.go_heartbeat_ms > 0 && goStaleMs <= TH.HEARTBEAT_MS * TH.MISSES;
  const streamOk = (sig.stream_lag_ms ?? Infinity) <= TH.STREAM_LAG_MS;
  const leaseOk = !sig.lease_expires_ms || sig.lease_expires_ms > sig.now_ms;
  const pxOk = (sig.price_lag_ms ?? 0) <= TH.PRICE_STALE_MS;
  const d1Ok = !sig.d1_down;

  if (!d1Ok) { reasons.push("d1_unavailable"); }
  if (!goHealthy) reasons.push(`go_unhealthy(hb_age=${goStaleMs}ms)`);
  if (!streamOk) reasons.push(`stream_lag=${sig.stream_lag_ms}ms`);
  if (!pxOk) reasons.push(`price_stale=${sig.price_lag_ms}ms`);
  if (!leaseOk) reasons.push("lease_expired");

  let mode = "PRIMARY";
  if (!d1Ok) mode = "D1_DOWN";
  else if (!goHealthy && !sig.fallback_active) mode = "DEGRADED";
  else if (sig.fallback_active) mode = "FALLBACK";
  else if (reasons.length > 0) mode = "DEGRADED";
  return { mode, reasons, components: componentRows(sig, false) };
}

function componentRows(sig, halted) {
  const goAge = sig.go_heartbeat_ms ? sig.now_ms - sig.go_heartbeat_ms : null;
  return [
    { component: "go", status: goAge === null ? "DOWN" : goAge <= TH.HEARTBEAT_MS * TH.MISSES ? "UP" : "UNHEALTHY", detail: { hb_age_ms: goAge } },
    { component: "redis", status: (sig.stream_lag_ms ?? Infinity) <= TH.STREAM_LAG_MS ? "UP" : "LAG", detail: { lag_ms: sig.stream_lag_ms ?? null } },
    { component: "d1", status: sig.d1_down ? "DOWN" : "UP", detail: {} },
    { component: "lease", status: !sig.lease_expires_ms || sig.lease_expires_ms > sig.now_ms ? "HELD" : "EXPIRED", detail: { holder: sig.lease_holder ?? null } },
    { component: "prices", status: (sig.price_lag_ms ?? 0) <= TH.PRICE_STALE_MS ? "FRESH" : "STALE", detail: { lag_ms: sig.price_lag_ms ?? null } },
    { component: "kill_switch", status: halted ? "ENGAGED" : "OFF", detail: {} },
  ];
}

/** Mode-change detection: returns the change to record or null (idempotent cron). */
export function modeChange(prevMode, next) {
  if (prevMode && prevMode !== next.mode) {
    return { from: prevMode, to: next.mode, reasons: next.reasons, at: new Date().toISOString() };
  }
  return null;
}

/** Return-to-primary gate (§6.3): healthy 60s + reconcile done + drain + lease handoff. */
export function canReturnToPrimary(s) {
  const checks = {
    go_healthy_60s: (s.healthy_contig_ms ?? 0) >= TH.RECOVER_CONTIG_MS,
    reconciled: s.non_terminal_intents === 0,
    drained: s.fallback_inflight === 0,
    lease_handoff: s.lease_ours === true,
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, checks, missing: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k) };
}

/** Badge for dashboard (§09.2): PRIMARY green / DEGRADED amber / FALLBACK orange /
 * HALTED red / D1_DOWN grey. */
export function badge(mode) {
  return ({ PRIMARY: "green", DEGRADED: "amber", FALLBACK: "orange", HALTED: "red", D1_DOWN: "grey" })[mode] ?? "grey";
}

