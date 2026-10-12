// nightly-report.mjs — E11-T01-S2: the DAILY paper-gate report.
//
// Reads the ledger a real paper run produced and writes
// `docs/ops/paper/day-<N>-<date>.json` with the ONE number that must stay at
// zero (unapproved orders) plus the supporting audits. Cadence: nightly
// (docs/11 §11.1). Day numbering starts at 1 on the first run after the
// deployed stack goes live (E12); `--day` is explicit so a re-run is honest.
//
// usage:
//   node scripts/nightly-report.mjs --db /var/lib/trading-agent/paper.sqlite \
//        --day 3 [--suites-json ref.json] [--out docs/ops/paper]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditIntents, auditTerminal, gateReport } from "./paper-gate.mjs";

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const DB = arg("db");
const DAY = Number(arg("day", "1"));
const OUT = arg("out", "docs/ops/paper");
const SUITES = arg("suites-json");

if (!DB) { console.error("refusing: --db is required"); process.exit(1); }

const sqlJson = (q) => {
  const tmp = join(tmpdir(), `nr-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, `.mode json\n${q}`);
  try {
    const out = execFileSync("sqlite3", ["-cmd", ".timeout 4000", DB], { input: readFileSync(tmp), encoding: "utf8" }).trim();
    return out ? JSON.parse(out) : [];
  } finally { rmSync(tmp, { force: true }); }
};

const intents = sqlJson("SELECT id, approval_id, client_order_id, status, at FROM order_intents;");
const approvals = sqlJson("SELECT id, decision, used_at, expires_at, at FROM approvals;");
const incidents = sqlJson("SELECT id, incident, action, actor, at FROM recovery_log ORDER BY at DESC LIMIT 500;");
let suites = { ok: false, detail: { reason: "no --suites-json provided; attach the CI run reference" } };
if (SUITES) {
  try { suites = { ok: JSON.parse(readFileSync(SUITES, "utf8")).ok === true, detail: { ref: SUITES } }; }
  catch { suites = { ok: false, detail: { reason: `unreadable ${SUITES}` } }; }
}

const audit = auditIntents(intents, approvals);
const report = gateReport({ day: DAY, intents, approvals, incidents, suites, env: process.env });
const payload = {
  ...report,
  kind: "nightly-paper-report",
  audit: { unapproved_count: audit.unapproved_count, unapproved: audit.unapproved },
  counts: { intents: intents.length, approvals: approvals.length, incidents: incidents.length },
  clock: "the 14-day window is calendar time (docs/00 S-01); it starts when the deployed stack runs (E12)",
};
mkdirSync(OUT, { recursive: true });
const date = report.at.slice(0, 10);
const p = join(OUT, `day-${String(DAY).padStart(2, "0")}-${date}.json`);
writeFileSync(p, JSON.stringify(payload, null, 2) + "\n");
console.log(`nightly report: ${p}`);
console.log(`day ${DAY} — unapproved_count=${audit.unapproved_count} — ${payload.decision}`);
process.exit(payload.ok ? 0 : 1);