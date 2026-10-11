#!/usr/bin/env node
// dev-server.mjs — the local Workers plane for the E06-T02 failover drills.
//
// WHY THIS EXISTS: `wrangler dev` cannot run on this machine — workerd is linked against
// a macOS ≥ 13.5 libc++ and fails to load on 12.6 ("Expected in: '/usr/lib/libc++.1.dylib'").
// This shim serves the SAME worker entrypoint (`workers/src/index.mjs` default export) and
// drives the SAME cron entry (`runCron`) on the same 10s interval, over a sqlite-backed D1
// (the interface the unit tests already exercise). The drills therefore run production code
// paths — routes, cron, health evaluator, reconcile sweep, lease, poller — not a rewrite.
//
// Local harness only: no remote binding, no secrets, binds 127.0.0.1.
//
// usage: node scripts/dev-server.mjs [--port 8787] [--cron-ms 10000] [--db /tmp/e06.sqlite] [--no-seed] [--verbose]
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql"];

export function parseFlags(argv) {
  const flags = { port: 8787, cronMs: 10_000, db: join(tmpdir(), "e06-drill.sqlite"), seed: true, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") flags.port = Number(argv[++i]);
    else if (a === "--cron-ms") flags.cronMs = Number(argv[++i]);
    else if (a === "--db") flags.db = argv[++i];
    else if (a === "--no-seed") flags.seed = false;
    else if (a === "--verbose") flags.verbose = true;
  }
  return flags;
}

/** One sqlite3 invocation. A busy timeout keeps the cron and an out-of-band `sqlite3`
 *  read (chaos --db) from colliding into "database is locked". */
export function sqlite(dbFile, sqlText, { json = false } = {}) {
  const tmp = join(tmpdir(), `devsrv-${process.pid}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, json ? `.mode json\n${sqlText}` : sqlText);
  try {
    return execFileSync("sqlite3", ["-cmd", ".timeout 4000", dbFile], {
      input: readFileSync(tmp), encoding: "utf8",
    });
  } finally { rmSync(tmp, { force: true }); }
}

/** A D1-shaped binding over the sqlite file (prepare/bind/all/run/batch). */
export function createD1(dbFile, log = () => {}) {
  const prepare = (stmt) => ({
    _stmt: stmt, _args: [],
    bind(...args) { this._args = args; return this; },
    _sql() {
      let i = 0;
      const out = this._stmt.replaceAll("?", () => {
        const v = this._args[i++];
        if (v === null || v === undefined) return "NULL";
        if (typeof v === "number") return String(v);
        return `'${String(v).replaceAll("'", "''")}'`;
      });
      return /^\s*(SELECT|PRAGMA)/i.test(out) && !/;\s*$/.test(out) ? out + ";" : out;
    },
    async all() {
      if (!/^\s*(SELECT|PRAGMA)/i.test(this._stmt)) { sqlite(dbFile, this._sql()); return { results: [] }; }
      const raw = sqlite(dbFile, this._sql(), { json: true }).trim();
      return { results: raw ? JSON.parse(raw) : [] };
    },
    async run() {
      log(`db: ${this._sql().replace(/\s+/g, " ").slice(0, 110)}`);
      sqlite(dbFile, this._sql());
      return {};
    },
  });
  return { prepare, async batch(list) { for (const s of list) await s.run(); } };
}

export function migrate(dbFile, log = () => {}) {
  const chain = MIGRATIONS.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  sqlite(dbFile, chain);
  log(`migrated ${dbFile}`);
}

/** Seed the ACTIVE watch set the Go cold start loads (§6.6: a non-empty comparison). */
export function seed(dbFile, log = () => {}) {
  const count = Number(sqlite(dbFile, "SELECT COUNT(*) FROM watches;").trim() || 0);
  if (count > 0) return 0;
  const now = new Date().toISOString();
  const rows = [["w-drill-1", "BTCUSDT"], ["w-drill-2", "ETHUSDT"], ["w-drill-3", "SOLUSDT"]];
  const values = rows.map(([id, symbol]) =>
    `('${id}','${symbol}','LONG','{"kind":"DIVERGENCE_TRIPLE"}','{}','ACTIVE',1,'e06-drill','${now}','${now}')`).join(",");
  sqlite(dbFile, "INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,created_at,updated_at) VALUES " + values + ";");
  log(`seeded ${rows.length} ACTIVE watches`);
  return rows.length;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const log = (...a) => console.log("dev-server:", ...a);
  mkdirSync(dirname(flags.db), { recursive: true });
  if (!existsSync(flags.db)) writeFileSync(flags.db, "");
  migrate(flags.db, log);
  if (flags.seed) seed(flags.db, log);

  const env = { DB: createD1(flags.db, flags.verbose ? log : () => {}), ENV: "dev", HUMAN_APPROVAL_REQUIRED: "true" };
  const worker = (await import(join(ROOT, "workers/src/index.mjs"))).default;
  const { runCron } = await import(join(ROOT, "workers/src/index.mjs"));

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = `http://127.0.0.1:${flags.port}${req.url}`;
      try {
        const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
        const request = new Request(url, { method: req.method, headers: req.headers, body });
        const response = await worker.fetch(request, env);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (e) {
        log(`fetch error: ${e.message}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  await new Promise((resolve) => server.listen(flags.port, "127.0.0.1", resolve));
  log(`ready on http://127.0.0.1:${flags.port} (db=${flags.db}, cron=${flags.cronMs}ms)`);

  // The production cron cadence (wrangler.toml [triggers] crons = "*/10 * * * * *").
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return; // never overlap a tick
    ticking = true;
    try {
      const out = await runCron(env, { actor: "dev-server" });
      log(`cron: mode=${out.tick.mode} rejoin=${JSON.stringify(out.rejoin)} sweep=${out.sweep ? out.sweep.remaining : "skipped"} poll=${out.poll ? out.poll.round : "n/a"}`);
    } catch (e) {
      log(`cron error: ${e.message}`);
    } finally { ticking = false; }
  }, flags.cronMs);

  const shutdown = () => { clearInterval(timer); server.close(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// NOTE: compare via pathToFileURL — this repo path contains a space, so a naive
// `file://${argv[1]}` never matches the percent-encoded import.meta.url.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error("dev-server:", e); process.exit(1); });