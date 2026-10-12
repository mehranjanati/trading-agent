// paper-gate.mjs — E11-T01: the paper-gate audit + the day-14 gate report.
//
// SAFE-007 / S-01: the paper run must show ZERO unapproved orders before any
// live discussion, and the verdict is a SIGNED human decision. This module is
// the pure audit: it never "passes" anything by default — every check is a
// red flag until the evidence says otherwise, and the report always carries
// `signed_by: null` until a human signs it at day 14.
//
// The 14 days are a CALENDAR requirement (docs/11 §11.1, docs/00 S-01). They
// cannot be compressed or simulated: the clock starts when the deployed stack
// (E12) runs the loop continuously, and these functions read whatever the run
// produced — one day at a time.
export const UNKNOWN_ALERT_MS = 300_000; // docs/05 §5.4: SUBMIT_UNKNOWN alert >5min
export const LIVE_INTENT_STATES = ["SUBMITTED", "SUBMIT_UNKNOWN", "ACKED", "PARTIAL"];

/** The gate report (E11-T01-S3): explicit decision, human signature placeholder.
 *  `paper_only` is a hard check: the report refuses to pass if anything smells
 *  like a live path (SAFE-007 — paper/testnet only until the gate passes).
 *  @param {{
 *   day?: number, intents?: any[], approvals?: any[], incidents?: any[],
 *   nowMs?: number, suites?: { ok: boolean, detail?: any }, env?: Record<string,string|undefined>,
 *   approved_by?: string|null,
 *  }} [args]
 *  @returns {{ task: string, day: number, at: string, checks: {name:string,ok:boolean,detail?:any}[],
 *              ok: boolean, decision: string, signed_by: string|null }} */
export function gateReport({ day = 0, intents = [], approvals = [], incidents = [], nowMs = Date.now(), suites = { ok: false }, env = process.env, approved_by = null } = {}) {
  const audit = auditIntents(intents, approvals);
  const reuse = auditApprovalReuse(intents);
  const unknown = auditUnknown(intents, nowMs);
  const term = auditTerminal(intents, nowMs);

  // SAFE-007: the gate refuses if anything in the LIVE_* namespace exists —
  // `LIVE_TRADING_ENABLED` must not exist in any form (docs/08, human release
  // gate). Unrelated env vars (IDE/tooling) are deliberately not suspects.
  const liveSmell = Object.keys(env ?? {}).filter((k) => /^LIVE_/.test(k));
  const checks = [
    { name: "zero_unapproved_orders", ok: audit.ok, detail: { unapproved_count: audit.unapproved_count, unapproved: audit.unapproved } },
    { name: "approval_single_use", ok: reuse.ok, detail: { reused: reuse.reused } },
    { name: "no_unresolved_submit_unknown", ok: unknown.ok, detail: { lingering: unknown.lingering } },
    { name: "terminal_coverage", ok: term.ok, detail: { live: term.live, terminal_count: term.terminal_count } },
    { name: "paper_only", ok: liveSmell.length === 0, detail: { suspect_vars: liveSmell } },
    { name: "suites_green", ok: suites.ok === true, detail: suites.detail ?? null },
  ];
  const ok = checks.every((c) => c.ok !== false);
  return {
    task: "E11-T01",
    day,
    at: new Date(nowMs).toISOString(),
    checks,
    ok,
    decision: ok ? "PASS — evidence complete; file for the human release gate" : "FAIL — do not proceed to any live discussion",
    signed_by: approved_by, // null until a HUMAN signs at day 14 (docs/tasks/TEST-AND-RELEASE-GATES.md)
  };
}

/** SAFE-002 audit: every order intent must trace to a CONSUMED approval.
 *  A missing/ungranted/unused approval is an unapproved order — the one number
 *  the nightly report exists to keep at zero. */
export function auditIntents(intents = [], approvals = []) {
  const byId = new Map((approvals ?? []).map((a) => [a.id, a]));
  const rows = (intents ?? []).map((i) => {
    const a = byId.get(i.approval_id);
    const verdict = !a ? "no_approval"
      : a.decision !== "approve" ? "approval_not_granted"
      : !a.used_at ? "approval_unused"
      : "ok";
    return {
      intent_id: i.id, client_order_id: i.client_order_id, approval_id: i.approval_id,
      status: i.status, verdict,
    };
  });
  const unapproved = rows.filter((r) => r.verdict !== "ok");
  return { rows, unapproved, unapproved_count: unapproved.length, ok: unapproved.length === 0 };
}

/** docs/08 §8.4: one approval never mints two intents. Rejected intents are
 *  exempt (they are recorded, not executed) — same rule the schema encodes. */
export function auditApprovalReuse(intents = []) {
  const counts = new Map();
  for (const i of intents ?? []) {
    if (i.status === "RISK_REJECTED") continue;
    counts.set(i.approval_id, (counts.get(i.approval_id) ?? 0) + 1);
  }
  const reused = [...counts].filter(([, n]) => n > 1).map(([approval_id, n]) => ({ approval_id, n }));
  return { reused, ok: reused.length === 0 };
}

/** docs/05 §5.4: SUBMIT_UNKNOWN is reconcile-only and must alert after 5min. */
export function auditUnknown(intents = [], nowMs = Date.now(), { maxMs = UNKNOWN_ALERT_MS } = {}) {
  const lingering = (intents ?? [])
    .filter((i) => i.status === "SUBMIT_UNKNOWN")
    .filter((i) => nowMs - Date.parse(i.at ?? "") > maxMs)
    .map((i) => ({ intent_id: i.id, client_order_id: i.client_order_id, age_ms: nowMs - Date.parse(i.at ?? "") }));
  return { lingering, ok: lingering.length === 0 };
}

/** docs/05 §5.4: every intent reaches a terminal state. Still-live intents are
 *  reported with their age so a stuck paper order is visible, not hidden. */
export function auditTerminal(intents = [], nowMs = Date.now()) {
  const live = (intents ?? []).filter((i) => LIVE_INTENT_STATES.includes(i.status))
    .map((i) => ({ intent_id: i.id, status: i.status, age_ms: nowMs - Date.parse(i.at ?? "") }));
  const terminal = (intents ?? []).filter((i) => ["FILLED", "REJECTED", "CANCELLED", "EXPIRED", "RISK_REJECTED"].includes(i.status));
  return { live, live_count: live.length, terminal_count: terminal.length, ok: live.length === 0 };
}