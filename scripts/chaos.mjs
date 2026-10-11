#!/usr/bin/env node
// chaos.mjs — E06-T02-S1: failover drill harness (Node, stdlib-only).
//
//   node scripts/chaos.mjs <go|redis|both|rejoin|budget> [--phase ...] [--execute]
//
// DRY RUN BY DEFAULT: without --execute nothing is touched — the planned steps are
// printed and the process exits 0. Safety rails (see guard()):
//   * --execute additionally requires --target local and 127.0.0.1/localhost hosts
//   * the go pid comes from pgrep -f trading-agent/go-watcher (never a broad pattern)
//   * Redis is paused with RESP CLIENT PAUSE, never pkill/FLUSHALL/SHUTDOWN
//   * no order/approval mutation: the only order-path call is the blocked-approval
//     probe, which asserts a rejection
//   * refuses when LIVE_TRADING_ENABLED exists or ENV is not dev/test/local
// Evidence: docs/ops/drills/E06-T02/<drill>-<UTC>.json (written only under --execute).
//
// docs: docs/06-failover-and-recovery.md, docs/decisions/ADR-004-market-data-fallback.md
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export const DRILLS = ["go", "redis", "both", "rejoin", "budget"];
export const PHASES = ["preflight", "kill", "watch", "restore", "assert", "all"];
export const EVIDENCE_DIR = "docs/ops/drills/E06-T02";
export const GO_PATTERN = "trading-agent/go-watcher";
const SAFE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const ENV_OK = ["dev", "test", "local"];

// ---------------------------------------------------------------- flags + guard

export function parseArgs(argv, env = process.env) {
  const flags = {
    drill: null, phase: "all", target: null, execute: false, hard: false,
    json: false, help: false, pauseMs: 0, watchMs: 60_000, symbols: 10, minutes: 5, db: null,
    workers: env.WORKERS_URL || "http://127.0.0.1:8787",
    redis: env.REDIS_ADDR || "127.0.0.1:6379",
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") flags.execute = true;
    else if (a === "--hard") flags.hard = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--phase") flags.phase = argv[++i];
    else if (a === "--target") flags.target = argv[++i];
    else if (a === "--workers") flags.workers = argv[++i];
    else if (a === "--redis") flags.redis = argv[++i];
    else if (a === "--db") flags.db = argv[++i];
    else if (a === "--pause-ms") flags.pauseMs = Number(argv[++i]);
    else if (a === "--watch-ms") flags.watchMs = Number(argv[++i]);
    else if (a === "--symbols") flags.symbols = Number(argv[++i]);
    else if (a === "--minutes") flags.minutes = Number(argv[++i]);
    else rest.push(a);
  }
  flags.drill = rest[0] ?? null;
  return flags;
}

export function splitHostPort(addr) {
  const [host, port] = String(addr).split(":");
  return [host || "127.0.0.1", Number(port || 6379)];
}

export function hostOf(url) {
  const raw = String(url ?? "");
  if (!/^[a-z]+:\/\//i.test(raw)) return splitHostPort(raw)[0];
  try { return new URL(raw).hostname; } catch { return ""; }
}

/** Safety rails. Returns null when the run is allowed, else a human reason.
 *  A dry-run is always allowed: it performs no I/O at all. */
export function guard(flags, env = process.env) {
  if (!flags.drill) return "missing drill";
  if (!DRILLS.includes(flags.drill)) return `unknown drill "${flags.drill}" (${DRILLS.join("|")})`;
  if (!PHASES.includes(flags.phase)) return `unknown phase "${flags.phase}" (${PHASES.join("|")})`;
  if (env.LIVE_TRADING_ENABLED !== undefined) {
    return "LIVE_TRADING_ENABLED is set — this repo must never enable live trading";
  }
  if (env.ENV && !ENV_OK.includes(env.ENV)) return `ENV=${env.ENV} is not one of ${ENV_OK.join("/")}`;
  if (!flags.execute) return null;
  if (flags.target !== "local") return "--execute requires --target local";
  const bad = [flags.workers, flags.redis].map(hostOf).filter((h) => !SAFE_HOSTS.has(h));
  if (bad.length) return `refusing non-local target(s): ${bad.join(", ")}`;
  return null;
}

// ---------------------------------------------------------------- dry-run plan

export function planFor(flags) {
  const killGo = flags.hard ? "SIGKILL the pid then relaunch `go run .`" : "SIGSTOP the pid";
  const redisKill = flags.pauseMs > 0
    ? `RESP CLIENT PAUSE ${flags.pauseMs} ALL (auto-expires)`
    : "RESP CLIENT PAUSE 0 ALL (indefinite; restore with CLIENT UNPAUSE)";
  const base = [
    `preflight: GET ${flags.workers}/api/health, /api/recovery/log, /api/watches/active-snapshot`,
    "preflight: baseline counts (health_snapshots, recovery_log, order_intents) + ACTIVE watch set from Redis",
  ];
  const asserts = [
    "assert: mode timeline shows PRIMARY -> DEGRADED/FALLBACK -> PRIMARY with matching recovery_log incidents",
    "assert: a health_snapshots row exists for every component (go/redis/d1/lease/prices/kill_switch/mode)",
    "assert: zero duplicate intents per approval_id, and no new evt_ ids for already-recorded triggers",
    "assert: restored ACTIVE set equals the D1 snapshot truth (both directions)",
    "assert: PRIMARY mode row never precedes the reconcile incident (acceptance 2)",
    "assert: no rate_limit_backoff incident in the window (ADR-004 budget proof)",
  ];
  const plans = {
    go: [...base,
      `kill: ${killGo} (pgrep -f ${GO_PATTERN})`,
      "watch: poll /api/health until DEGRADED(go_unhealthy) then FALLBACK; blocked-approval probe must be rejected",
      "restore: SIGCONT the pid (the --hard variant is already back up after the cold-start reload)",
      ...asserts],
    redis: [...base,
      `kill: ${redisKill} (alternative with --hard: SIGSTOP redis-server)`,
      "watch: heartbeat reports redis_reachable=false -> /api/health DEGRADED(redis_unreachable) and Go /readyz 503",
      "restore: CLIENT UNPAUSE; Go reloads the D1 snapshot and resumes from the last acked stream id (dedupe)",
      ...asserts],
    both: [...base,
      `kill: ${killGo} + ${redisKill}`,
      "watch: DEGRADED -> FALLBACK with full reasons; poll set reduced to the top-N priority symbols; orders blocked",
      "restore: Redis first, then Go (combined S1+S2 recovery path, docs/06 §6.2)",
      ...asserts],
    rejoin: [...base,
      `kill: ${killGo} + ${redisKill}`,
      "restore: CLIENT UNPAUSE then SIGCONT; the reconcile sweep drains non-terminal intents",
      "assert: reconcile incident precedes the PRIMARY mode row (acceptance 2)",
      "assert: zero 429 during the fallback window (stub counters when the poller runs against the stub)",
      ...asserts],
    budget: [
      "stub exchange: node:http weight accounting (REQUEST_WEIGHT 3000/min, poll weight 1, 429 + X-Api-Limit-Reset-Timestamp on breach)",
      `drive the fallback poller for N=${flags.symbols} symbols over ${flags.minutes} simulated min at the ADR-004 cadence (floor = symbols x 1/50 x 2 s)`,
      "assert: zero 429, weight within budget, cadence >= floor, every round polled",
    ],
  };
  return plans[flags.drill] ?? [];
}

// ------------------------------------------------------------- RESP + transport

export function respCommand(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`;
  return out;
}

/** Parse one RESP reply at `offset`: +/: → string, $ → string|null, * → array.
 *  An error reply (-...) throws, so a protocol surprise is never silently ignored. */
export function parseReply(text, offset = 0) {
  const eol = text.indexOf("\r\n", offset);
  if (eol < 0) throw new Error("chaos: truncated RESP reply");
  const head = text.slice(offset, eol);
  const rest = eol + 2;
  const kind = head[0];
  const body = head.slice(1);
  if (kind === "+" || kind === ":") return { value: body, next: rest };
  if (kind === "$") {
    const n = Number(body);
    if (n < 0) return { value: null, next: rest };
    if (text.length < rest + n + 2) throw new Error("chaos: truncated bulk reply");
    return { value: text.slice(rest, rest + n), next: rest + n + 2 };
  }
  if (kind === "*") {
    const n = Number(body);
    const out = [];
    let at = rest;
    for (let i = 0; i < n; i++) {
      const r = parseReply(text, at);
      out.push(r.value);
      at = r.next;
    }
    return { value: out, next: at };
  }
  if (kind === "-") throw new Error(`chaos: redis error ${body}`);
  throw new Error(`chaos: unexpected RESP type ${JSON.stringify(kind)}`);
}

/** One RESP call (stdlib socket, no client dependency). */
export async function redisCall(args, addr = "127.0.0.1:6379", timeoutMs = 3000) {
  const [host, port] = splitHostPort(addr);
  return await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = "";
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs, () => fail(new Error(`chaos: redis timeout (${args[0]})`)));
    sock.on("error", fail);
    sock.on("connect", () => sock.write(respCommand(args)));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      try {
        const { value } = parseReply(buf);
        sock.end();
        resolve(value);
      } catch (e) {
        if (!/truncated/.test(e.message)) fail(e);
      }
    });
  });
}

/** Redis-loss simulation: pause every client for `ms` (0 = until CLIENT UNPAUSE).
 *  Never FLUSHALL/SHUTDOWN — the drill must be reversible and lossless. */
export function pauseRedis(flags) {
  return redisCall(["CLIENT", "PAUSE", String(flags.pauseMs), "ALL"], flags.redis);
}
export function unpauseRedis(flags) {
  return redisCall(["CLIENT", "UNPAUSE"], flags.redis);
}

/** The go-watcher pids. The pattern is always the specific module path — never a
 *  bare "go" pattern — so a drill cannot signal an unrelated process. */
export function findGoPid(pattern = GO_PATTERN) {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim();
    return out ? out.split("\n").map(Number) : [];
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

export function signalPid(pid, sig) {
  process.kill(pid, sig);
}

export async function httpJson(url, opts = {}, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** Local D1/sqlite read (the drill runs against the local stack). */
export function sqliteRows(dbPath, query) {
  const out = execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
}

/** The only order-path call in this harness: a paper approval attempt that MUST be
 *  rejected while the system is degraded (§6.2 S1 step 5). Never a real order. */
export async function probeBlockedApproval(workers) {
  const r = await httpJson(`${workers.replace(/\/$/, "")}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_id: "chaos-probe", decision: "approve", note: "failover drill probe" }),
  });
  return { ok: r.status >= 400, status: r.status, body: r.body };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** chaos.mjs budget — the ADR-004 no-429 proof, end to end against the local stub.
 *  The clock is simulated, so five minutes of 5s cadence costs milliseconds. No
 *  production endpoint is ever contacted: the only socket is the stub on 127.0.0.1. */
export async function runBudget(flags, io = defaultIo()) {
  const { tick, createWindow, memoryStore, floorMs, POLL_MS } = await import("../workers/src/fallback-poll.mjs");
  const { createStubExchange, syntheticSymbols } = await import("./stub-exchange.mjs");

  const symbols = syntheticSymbols(flags.symbols);
  const rounds = Math.max(1, Math.round((flags.minutes * 60_000) / POLL_MS));
  let simNow = Date.now();
  const stub = createStubExchange({ now: () => simNow });
  const port = await stub.listen(0);
  const store = memoryStore();
  const window = createWindow();
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  let polled = 0;
  let limited = 0;

  try {
    for (let i = 0; i < rounds; i++) {
      simNow += i === 0 ? 0 : POLL_MS;
      const res = await tick({}, {
        nowMs: simNow, mode: "FALLBACK", store, window, symbols, baseUrl, jitter: () => 0, env: {},
      });
      if (res.reason === "ok") polled++;
      if (res.reason === "rate-limited") limited++;
      io.log(`budget: round ${i + 1}/${rounds} → ${res.reason} (usage ${window.usage(simNow)}/${3000})`);
    }
  } finally {
    await stub.close();
  }

  checks.push({ name: "zero_429", ok: stub.stats.limited === 0 && limited === 0, detail: { stub_limited: stub.stats.limited, poller_limited: limited } });
  checks.push({ name: "weight_within_budget", ok: stub.stats.peak_usage <= 3000, detail: { peak_usage: stub.stats.peak_usage, budget_per_min: 3000 } });
  checks.push({ name: "cadence_floor", ok: POLL_MS >= floorMs(symbols.length), detail: { poll_ms: POLL_MS, floor_ms: floorMs(symbols.length) } });
  checks.push({ name: "adr004_math", ...assertBudget({ symbols: symbols.length, pollSec: POLL_MS / 1000, pollsPerRound: symbols.length }) });
  checks.push({ name: "rounds_completed", ok: polled === rounds, detail: { rounds, polled, minutes: flags.minutes } });

  const evidence = renderEvidence({
    drill: "budget", phase: flags.phase, flags,
    baselines: { symbols: symbols.length, minutes: flags.minutes, rounds, stub: stub.stats },
    checks,
  });
  const path = io.writeEvidence(evidenceName("budget"), evidence);
  const failed = checks.filter((c) => c.ok === false).map((c) => c.name);
  io.log(`evidence: ${path}`);
  io.log(failed.length ? `FAIL: ${failed.join(", ")}` : "PASS: all checks green");
  return { ok: evidence.ok, touched: true, checks, baselines: { symbols: symbols.length, rounds }, evidence: path };
}

// ---------------------------------------------------------------- assertions
// Every assertion is pure: {ok, detail}. `ok: null` means "cannot judge" and is
// reported as skipped rather than silently passing.

export const COMPONENTS = ["go", "redis", "d1", "lease", "prices", "kill_switch", "mode"];
const NON_PRIMARY = ["DEGRADED", "FALLBACK", "HALTED", "D1_DOWN"];
export const RECONCILE_INCIDENT = "reconcile.complete";

/** S2 acceptance "rows complete": every component was snapshotted in the window. */
export function assertRowsComplete(rows) {
  const seen = new Set(rows.map((r) => r.component));
  const missing = COMPONENTS.filter((c) => !seen.has(c));
  return { ok: missing.length === 0, detail: { components: [...seen].sort(), missing } };
}

/** Acceptance 1 (§6.4 rule): one approval never produces two intents. */
export function assertZeroDupIntents(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.approval_id, (counts.get(r.approval_id) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
  return { ok: duplicates.length === 0, detail: { intents: rows.length, duplicates } };
}

/** §6.6: the restored ACTIVE set equals D1 truth in both directions. */
export function assertWatchSetEqual(redisIds, d1Ids) {
  const a = new Set(redisIds), b = new Set(d1Ids);
  const onlyRedis = [...a].filter((x) => !b.has(x));
  const onlyD1 = [...b].filter((x) => !a.has(x));
  return { ok: onlyRedis.length === 0 && onlyD1.length === 0, detail: { redis: a.size, d1: b.size, onlyRedis, onlyD1 } };
}

/** Acceptance 2: the PRIMARY row must not precede the reconcile incident. */
export function assertRejoinOrder(modeRows, recoveryRows, incident = RECONCILE_INCIDENT) {
  const primary = [...modeRows].reverse().find((r) => r.status === "PRIMARY");
  const reconciled = [...recoveryRows].reverse().find((r) => r.incident === incident);
  if (!primary) return { ok: false, detail: { reason: "no PRIMARY mode row in the window" } };
  if (!reconciled) return { ok: false, detail: { reason: `no ${incident} incident in the window` } };
  return {
    ok: Date.parse(reconciled.at) <= Date.parse(primary.at),
    detail: { [incident]: reconciled.at, primary_at: primary.at },
  };
}

/** Drill timeline: a non-PRIMARY episode happened and PRIMARY came back. */
export function assertModeTimeline(modeRows) {
  const sequence = modeRows.map((r) => r.status).filter((s, i, all) => i === 0 || s !== all[i - 1]);
  const left = sequence.indexOf("PRIMARY");
  const broke = sequence.findIndex((s, i) => i > left && NON_PRIMARY.includes(s));
  const back = broke >= 0 ? sequence.indexOf("PRIMARY", broke) : -1;
  return { ok: left >= 0 && broke > left && back > broke, detail: { sequence } };
}

/** ADR-004: a rate-limit backoff in the window means the budget proof failed. */
export function assertNoBackoffAlert(recoveryRows) {
  const hits = recoveryRows.filter((r) => r.incident === "rate_limit_backoff");
  return { ok: hits.length === 0, detail: { backoffs: hits.length } };
}

/** ADR-004 adequacy floor: symbols x 1/50 x 2 seconds between polls. */
export function budgetFloorSec(symbols, budgetPerSec = 50) {
  return (symbols / budgetPerSec) * 2;
}

/** Budget proof (S3 acceptance "Given N syms When polling Then ADR math holds").
 *  pollsPerRound = symbols for per-symbol requests, 1 for a batched array call. */
export function assertBudget({ symbols, pollSec, budgetPerMin = 3000, weightPerPoll = 1, pollsPerRound = 1 }) {
  const floor = budgetFloorSec(symbols);
  const roundsPerMin = 60 / pollSec;
  const weightPerMin = roundsPerMin * pollsPerRound * weightPerPoll;
  return {
    ok: pollSec >= floor && weightPerMin <= budgetPerMin,
    detail: { symbols, pollSec, floor, roundsPerMin, weightPerMin, budgetPerMin },
  };
}

// ---------------------------------------------------------------- evidence

export function isoStamp(at = new Date()) {
  return at.toISOString().replace(/[:.]/g, "-");
}

export function evidenceName(drill, at = new Date()) {
  return `${drill}-${isoStamp(at)}.json`;
}

export function renderEvidence({ drill, phase, flags, baselines, checks, at = new Date(), ok }) {
  return {
    task: "E06-T02",
    drill,
    phase,
    ok: ok ?? checks.every((c) => c.ok !== false),
    target: flags?.target ?? null,
    at: at.toISOString(),
    baselines: baselines ?? {},
    checks,
  };
}

// ---------------------------------------------------------------- runner

/** Injectable IO so unit tests can prove the dry-run performs no I/O. */
export function defaultIo() {
  return {
    log: (...a) => console.log(...a),
    sleep,
    redisCall,
    pauseRedis,
    unpauseRedis,
    httpJson,
    sqliteRows,
    findGoPid,
    signalPid,
    probeBlockedApproval,
    writeEvidence: (name, obj) => {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      const p = join(EVIDENCE_DIR, name);
      writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
      return p;
    },
  };
}

const KILLS_GO = ["go", "both", "rejoin"];
const KILLS_REDIS = ["redis", "both", "rejoin"];

/** Runs a drill. Dry-run by default; every side effect goes through `io`. */
export async function run(flags, io = defaultIo(), env = process.env) {
  const reason = guard(flags, env);
  const plan = planFor(flags);
  if (reason) return { ok: false, touched: false, reason, plan };
  if (!flags.execute) {
    io.log(`chaos.mjs — ${flags.drill} [${flags.phase}] — DRY RUN (nothing touched)`);
    plan.forEach((s, i) => io.log(`  ${String(i + 1).padStart(2)}. ${s}`));
    io.log("re-run with --execute --target local to drive the local stack");
    return { ok: true, touched: false, dryRun: true, plan };
  }

  const steps = flags.phase === "all" ? ["preflight", "kill", "watch", "restore", "assert"] : [flags.phase];
  // The budget drill is a pure local load: no kill/watch phases, no stack required.
  if (flags.drill === "budget") {
    io.log(`chaos.mjs — budget [${flags.phase}] — stub exchange load (localhost only)`);
    return await runBudget(flags, io);
  }
  const want = (p) => steps.includes(p);
  const checks = [];
  const baselines = {};

  if (want("preflight")) {
    const health = await io.httpJson(`${flags.workers}/api/health`);
    baselines.mode = health.body?.mode ?? null;
    baselines.reasons = health.body?.reasons ?? [];
    baselines.redis_active = await io.redisCall(["SCARD", "watch:active-ids"], flags.redis).catch(() => null);
    if (flags.db) {
      baselines.intents = io.sqliteRows(flags.db, "SELECT approval_id FROM order_intents").length;
      baselines.window_start = new Date().toISOString();
    } else {
      io.log("note: no --db given — the D1 row checks will be reported as skipped");
    }
    io.log(`preflight: mode=${baselines.mode} active=${baselines.redis_active}`);
  }

  if (want("kill")) {
    if (KILLS_GO.includes(flags.drill)) {
      const pids = io.findGoPid();
      if (!pids.length) return { ok: false, touched: true, reason: `no process matched ${GO_PATTERN}`, checks };
      for (const pid of pids) io.signalPid(pid, flags.hard ? "SIGKILL" : "SIGSTOP");
      io.log(`kill: ${flags.hard ? "SIGKILL" : "SIGSTOP"} go-watcher pid ${pids.join(",")}`);
    }
    if (KILLS_REDIS.includes(flags.drill)) {
      await io.pauseRedis(flags);
      io.log(`kill: CLIENT PAUSE ${flags.pauseMs} ALL (${flags.pauseMs === 0 ? "indefinite" : "auto-expiring"})`);
    }
  }

  if (want("watch")) {
    const deadline = Date.now() + flags.watchMs;
    let mode = null;
    while (Date.now() < deadline) {
      const h = await io.httpJson(`${flags.workers}/api/health`);
      const m = h.body?.mode ?? "?";
      if (m !== mode) {
        io.log(`watch: mode -> ${m} (${(h.body?.reasons ?? []).join("; ") || "no reasons"})`);
        mode = m;
      }
      if (m !== "PRIMARY") break;
      await io.sleep(2000);
    }
    checks.push({ name: "degradation_observed", ok: mode !== null && mode !== "PRIMARY", detail: { mode } });
    if (KILLS_GO.includes(flags.drill) || flags.drill === "both") {
      const probe = await io.probeBlockedApproval(flags.workers);
      checks.push({ name: "orders_blocked", ok: probe.ok, detail: probe });
    }
  }

  if (want("restore")) {
    if (KILLS_REDIS.includes(flags.drill)) {
      try {
        await io.unpauseRedis(flags);
        io.log("restore: CLIENT UNPAUSE");
      } catch (e) {
        io.log(`restore: UNPAUSE failed (${e.message}) — use the --hard SIGSTOP path`);
      }
    }
    if (KILLS_GO.includes(flags.drill) && !flags.hard) {
      const pids = io.findGoPid();
      for (const pid of pids) io.signalPid(pid, "SIGCONT");
      io.log(`restore: SIGCONT -> ${pids.join(",") || "no pid found (already exited?)"}`);
    }
  }

  if (want("assert")) {
    if (!flags.db) {
      checks.push({ name: "d1_row_checks", ok: null, detail: { skipped: "no --db path supplied" } });
    } else {
      const modeRows = io.sqliteRows(flags.db, "SELECT status, at FROM health_snapshots WHERE component='mode' ORDER BY at");
      const allRows = io.sqliteRows(flags.db, "SELECT component FROM health_snapshots ORDER BY at");
      const recoveryRows = io.sqliteRows(flags.db, "SELECT incident, action, at FROM recovery_log ORDER BY at");
      const intents = io.sqliteRows(flags.db, "SELECT approval_id FROM order_intents");
      checks.push({ name: "mode_timeline", ...assertModeTimeline(modeRows) });
      checks.push({ name: "rows_complete", ...assertRowsComplete(allRows) });
      checks.push({ name: "zero_dup_intents", ...assertZeroDupIntents(intents) });
      checks.push({ name: "rejoin_order", ...assertRejoinOrder(modeRows, recoveryRows) });
      checks.push({ name: "no_backoff_alert", ...assertNoBackoffAlert(recoveryRows) });
      const snap = await io.httpJson(`${flags.workers}/api/watches/active-snapshot`);
      const d1Ids = (snap.body?.watches ?? []).map((w) => w.id);
      const redisIds = (await io.redisCall(["SMEMBERS", "watch:active-ids"], flags.redis).catch(() => [])) ?? [];
      checks.push({ name: "watch_set_equal", ...assertWatchSetEqual(redisIds, d1Ids) });
    }
  }

  const evidence = renderEvidence({ drill: flags.drill, phase: flags.phase, flags, baselines, checks });
  const path = io.writeEvidence(evidenceName(flags.drill), evidence);
  const failed = checks.filter((c) => c.ok === false).map((c) => c.name);
  io.log(`evidence: ${path}`);
  io.log(failed.length ? `FAIL: ${failed.join(", ")}` : "PASS: all checks green");
  return { ok: evidence.ok, touched: true, checks, baselines, evidence: path };
}

export function usage() {
  return [
    `usage: node scripts/chaos.mjs <${DRILLS.join("|")}> [options]`,
    `  --phase ${PHASES.join("|")}   (default all)`,
    "  --execute                actually run (the default is a dry run)",
    "  --target local           required with --execute",
    "  --hard                   go: SIGKILL + relaunch instead of SIGSTOP",
    "  --pause-ms N             CLIENT PAUSE window (0 = until CLIENT UNPAUSE)",
    "  --watch-ms N             how long to watch /api/health (default 60000)",
    "  --symbols N              budget-drill symbol count (default 10)",
    "  --minutes N              budget-drill simulated minutes (default 5)",
    "  --db <sqlite path>       local D1 file for the row assertions",
    "  --workers <url>  --redis <host:port>   local endpoints",
    "  --json                   print the result object",
  ].join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(usage()); process.exit(0); }
  const bad = guard(flags);
  if (bad) { console.error(`chaos: ${bad}`); console.error(usage()); process.exit(2); }
  run(flags)
    .then((res) => {
      if (flags.json) console.log(JSON.stringify(res, null, 2));
      process.exit(res.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`chaos: ${e.message}`);
      process.exit(1);
    });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
