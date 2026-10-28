// migrate-check.mjs — E04-T01-S1: validate migration CHAIN with system sqlite3.
// The chain is DISCOVERED from ./migrations (sorted) so a new file can never be
// silently skipped — the hardcoded list this replaces had already drifted
// (scripts/dev-server.mjs was missing 0005/0006).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(ROOT, "migrations"))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((f) => `migrations/${f}`);

// A CREATE TABLE may declare its primary key EITHER on the column or as a
// table-level constraint — never both. SQLite rejects the second declaration
// ("table X has more than one primary key"), but `CREATE TABLE IF NOT EXISTS`
// hides it whenever the table already exists, so the broken file only explodes
// on a fresh DB (0007_notify_prefs.sql shipped exactly that way). This lint
// checks the SQL itself, independent of what the chain happens to have created.
function lintCreateTables() {
  const bad = [];
  for (const f of files) {
    const sql = readFileSync(join(ROOT, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*;/gi)) {
      const [, table, body] = m;
      const columnPk = /\b\w+\s+[^,()]*\bPRIMARY\s+KEY\b(?![^,]*\()/i.test(body);
      const tablePk = /\bPRIMARY\s+KEY\s*\(/i.test(body);
      if (columnPk && tablePk) bad.push(`${f}: CREATE TABLE ${table} declares PRIMARY KEY twice (invalid SQL)`);
    }
  }
  return bad;
}

const lint = lintCreateTables();
if (lint.length) {
  lint.forEach((e) => console.error(`FAIL ${e}`));
  process.exit(1);
}
console.log(`migration lint: OK (${files.length} files, no duplicate primary keys)`);

const chain = files.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
const tmp = join(tmpdir(), `mig-check-${Date.now()}.sql`);
const run = (sql) => {
  writeFileSync(tmp, sql);
  return execSync(`sqlite3 :memory: < "${tmp}"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
};
run(chain);
console.log(`migration chain ${files[0]} -> ${files[files.length - 1]}: SQL valid`);
for (const f of files) console.log(`  ${f}: included`);
try {
  run(`${chain}\nINSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES('evt_1','t','w','{}','k1','now');\nINSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES('evt_2','t','w','{}','k1','now');\n`);
  console.error("FAIL: duplicate dedupe_key accepted"); process.exit(1);
} catch { console.log("dedupe UNIQUE: OK (duplicate rejected)"); }
const out = run(`${chain}\nSELECT config_json FROM strategy_configs WHERE version='v1-paper';\n`);
if (!out.includes("max_leverage")) { console.error("FAIL: seed unreadable"); process.exit(1); }
console.log("seed v1-paper: OK (readable)");
rmSync(tmp, { force: true });

rmSync(tmp, { force: true });


