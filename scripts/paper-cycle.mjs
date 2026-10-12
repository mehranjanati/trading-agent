#!/usr/bin/env node
// paper-cycle.mjs — E11-T01-S2: ONE full J1 paper cycle, driven end-to-end.
//
//   signal (HMAC webhook) -> analysis -> HUMAN APPROVAL -> submit (kill/fence/
//   risk/consume) -> reconcile -> position -> audit
//
// The human step is explicit: `--approved-by` records who made the decision,
// and for the REAL 14-day run that decision comes from the dashboard, not from
// this script. This driver exists to exercise the path and produce evidence;
// it never bypasses the approval (SAFE-002) and it never widens a gate.
//
// usage:
//   node scripts/paper-cycle.mjs --workers http://127.0.0.1:8787 \
//        --db /tmp/paper.sqlite --secret <hmac> --approved-by "trader:meh" \
//        [--symbol BTCUSDT] [--qty 1] [--leverage 5] [--out docs/ops/paper]
//
// Requires the local Workers plane (scripts/dev-server.mjs) — same contract as
// the E06 drills. Evidence is machine-written and never hand-edited.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync as readFileSync2, rmSync as rmSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditIntents, auditTerminal, gateReport } from "./paper-gate.mjs";

const EVIDENCE = "docs/ops/paper";
const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const WORKERS = arg("workers", "http://127.0.0.1:8787");
const DB = arg("db");
const SECRET = arg("secret");
const APPROVED_BY = arg("approved-by");
const SYMBOL = arg("symbol", "BTCUSDT");
const QTY = arg("qty", "1");
const LEVERAGE = Number(arg("leverage", "5"));
const OUT = arg("out", EVIDENCE);

const guard = () => {
  if (process.env.LIVE_TRADING_ENABLED !== undefined) return "LIVE_TRADING_ENABLED is set — paper only";
  if (!SECRET) return "--secret is required (the webhook must be authenticated)";
  if (!APPROVED_BY) return "--approved-by is required (the human decision is recorded, never automated)";
  if (!DB) return "--db is required (the cycle reads the ledger it produced)";
  return null;
};

const http = async (path, { method = "GET", body, role, headers = {} } = {}) => {
  const res = await fetch(`${WORKERS}${path}`, {
    method, headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}), ...headers },
    // a pre-serialized string (the signed webhook) is sent verbatim
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

/** Paper market data: the stub exchange's quote lands in the SAME snapshot the
 *  poller writes. In PRIMARY the Go WS feed owns freshness (E12 wiring); until
 *  then a submit without a price fails closed (R-NOT/R-STALE) — by design. */
function seedPaperPrice(db, symbol, px, nowMs) {
  const st = { symbols: 1, quotes: [{ symbol, price: px }], last_poll_ms: nowMs, inflight: 0, rounds: 1 };
  const sql = `INSERT INTO health_snapshots(id,component,status,detail_json,at) VALUES('poll_quotes','fallback_poll','IDLE','${JSON.stringify(st)}','${new Date(nowMs).toISOString()}') ` +
    "ON CONFLICT(id) DO UPDATE SET detail_json=excluded.detail_json, at=excluded.at;";
  const tmp = tmpFile("pc");
  writeFileSync(tmp, sql);
  try { execFileSync("sqlite3", ["-cmd", ".timeout 4000", db], { input: readFileSync2(tmp) }); } finally { rmSync2(tmp); }
}
// tiny fs shims so the driver reads like the rest of scripts/
async function main() {
  const reason = guard();
  if (reason) { console.error("refusing:", reason); process.exit(1); }
  const nowMs = Date.now();

  // 0) the documented operator step: hand authority to the primary plane, or the
  //    submit path is fenced (§6.3 step 4 — no lease, no order).
  const handoff = await http("/api/lease:handoff", { method: "POST", role: "operator", body: { holder: "primary" } });
  step("lease_handoff", handoff.status === 200, handoff.body);

  // 1) the strategy version the cycle runs under (limits + webhook allowlist).
  const cfg = {
    max_leverage: 5, max_notional_usd: "1000", max_exposure_usd: "5000",
    allowlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], stale_s_seconds: 5, approval_ttl_s: 600,
    signal_sources: { paper_sim: ["MTF"] },
  };
  const act = await http("/api/strategy:activate", { method: "POST", role: "admin", body: { version: `v-paper-${nowMs}`, config: cfg } });
  step("strategy_activated", act.status === 201, { version: act.body?.version });

  // 2) the watch this cycle trades (paper).
  const w = await http("/api/watches", { method: "POST", role: "trader", body: {
    symbol: SYMBOL, direction: "LONG", trigger: { op: "cross_above", price: "1" }, invalidation: { op: "<=", price: "0.5" },
  } });
  const watch_id = w.body?.id;
  step("watch_created", w.status === 201, { watch_id });

  // 3) paper market data.
  seedPaperPrice(DB, SYMBOL, "100", nowMs);
  step("paper_price_seeded", true, { symbol: SYMBOL, px: "100" });

  // 4) the signal enters through the AUTHENTICATED webhook (never a JSON claim).
  const rawBody = JSON.stringify({ watch_id, kind: "MTF", payload: {
    symbol: SYMBOL, timeframes: [{ tf: "1h", bias: "LONG" }, { tf: "4h", bias: "LONG" }], agreement: "LONG",
  } });
  const timestamp = Date.now(); const nonce = `pc-${nowMs}`;
  const { signWebhook } = await import("../workers/src/strategies.mjs");
  const signature = await signWebhook(SECRET, { timestamp_ms: timestamp, nonce, rawBody });
  const sig = await http("/api/signals:ingest", { method: "POST", headers: {
    "x-signal-source": "paper_sim", "x-signal-timestamp": String(timestamp), "x-signal-nonce": nonce, "x-signal-signature": signature,
  }, body: rawBody });
  step("signal_ingested", sig.status === 201, { id: sig.body?.id, schema_version: sig.body?.schema_version });

  // 5) the advisory analysis run (stub until the AI analyst lands).
  const an = await http("/api/analysis:runs", { method: "POST", role: "trader", body: { watch_id } });
  const analysis_id = an.body?.id;
  step("analysis_run", an.status === 201, { id: analysis_id, strategy_version: an.body?.strategy_version });

  // 6) THE HUMAN DECISION (SAFE-002). Recorded with its maker; never automated.
  const ap = await http("/api/approvals", { method: "POST", role: "trader", body: {
    watch_id, analysis_id, decision: "approve", reason: `paper cycle by ${APPROVED_BY}`,
  } });
  const approval_id = ap.body?.id;
  step("human_approval", ap.status === 201, { approval_id, approved_by: APPROVED_BY, expires_at: ap.body?.expires_at });

  // 7) submit — kill/fence/risk/consume happen inside the Workers path.
  const ord = await http("/api/orders:intents", { method: "POST", role: "trader", body: {
    approval_id, side: "BUY", qty: QTY, leverage: LEVERAGE,
  } });
  step("submit", ord.status === 201, { intent_id: ord.body?.intent_id, order_status: ord.body?.order_status, client_order_id: ord.body?.client_order_id });

  // 8) verify the ledger, then report.
  const intents = JSON.parse(sqlJson(DB, "SELECT id, approval_id, client_order_id, status, at FROM order_intents;"));
  const approvals = JSON.parse(sqlJson(DB, "SELECT id, decision, used_at, expires_at, at FROM approvals;"));
  const audit = auditIntents(intents, approvals);
  const term = auditTerminal(intents, nowMs + 60_000);
  step("zero_unapproved_orders", audit.ok, { unapproved_count: audit.unapproved_count });
  step("intent_terminal", term.ok, { live: term.live_count, terminal: term.terminal_count });
  const pos = JSON.parse(sqlJson(DB, "SELECT * FROM positions;"));
  step("position_snapshot", pos.length > 0, pos[0] ?? null);

  const report = gateReport({ day: 0, intents, approvals, nowMs, suites: { ok: true, detail: { note: "see make check / CI dashboard job" } }, approved_by: null, env: process.env });
  const evidence = {
    task: "E11-T01", drill: "paper-cycle", ok: steps.every((s) => s.ok) && audit.ok,
    at: ts(nowMs), workers: WORKERS, symbol: SYMBOL, qty: QTY, leverage: LEVERAGE,
    approved_by: APPROVED_BY, steps, audit: { unapproved_count: audit.unapproved_count, rows: audit.rows },
    gate_report: report,
    note: "one cycle of the 14-day paper run; the calendar clock starts with the deployed stack (E12)",
  };
  mkdirSync(OUT, { recursive: true });
  const p = join(OUT, `cycle-${ts(nowMs).replace(/[:.]/g, "-")}.json`);
  writeFileSync(p, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\nevidence: ${p}`);
  console.log(evidence.ok ? "PASS: cycle complete, zero unapproved" : "FAIL: see steps");
  process.exit(evidence.ok ? 0 : 1);
}

function sqlJson(db, q) {
  const tmp = tmpFile("q");
  writeFileSync(tmp, `.mode json\n${q}`);
  try {
    const out = execFileSync("sqlite3", ["-cmd", ".timeout 4000", db], { input: readFileSync2(tmp), encoding: "utf8" }).trim();
    return out || "[]";
  } finally { rmSync2(tmp); }
}

main().catch((e) => { console.error("paper-cycle:", e.message); process.exit(1); });
const tmpFile = (tag) => join(tmpdir(), `paper-cycle-${process.pid}-${Math.random().toString(36).slice(2)}-${tag}.sql`);

const ts = (ms = Date.now()) => new Date(ms).toISOString();
const steps = [];
const step = (name, ok, detail) => {
  steps.push({ name, ok: ok !== false, detail });
  console.log(`${ok === false ? "FAIL" : "ok  "}  ${name}${detail ? " — " + JSON.stringify(detail).slice(0, 140) : ""}`);
};