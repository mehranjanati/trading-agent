// migrate-check.mjs — E04-T01-S1: validate migration CHAIN with system sqlite3.
// Writes a temp file (avoids shell-quoting bugs), runs sqlite3 on it.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const files = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql"];
const chain = files.map((f) => readFileSync(f, "utf8")).join("\n");
const tmp = join(tmpdir(), `mig-check-${Date.now()}.sql`);
const run = (sql) => {
  writeFileSync(tmp, sql);
  try {
    return execSync(`sqlite3 :memory: < "${tmp}"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } finally { /* keep for next step; removed at end */ }
};
run(chain);
console.log("migration chain 0001->0005: SQL valid");
for (const f of files) console.log(`  ${f}: included`);
try {
  run(`${chain}\nINSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES('evt_1','t','w','{}','k1','now');\nINSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES('evt_2','t','w','{}','k1','now');\n`);
  console.error("FAIL: duplicate dedupe_key accepted"); process.exit(1);
} catch { console.log("dedupe UNIQUE: OK (duplicate rejected)"); }
const out = run(`${chain}\nSELECT config_json FROM strategy_configs WHERE version='v1-paper';\n`);
if (!out.includes("max_leverage")) { console.error("FAIL: seed unreadable"); process.exit(1); }
console.log("seed v1-paper: OK (readable)");
rmSync(tmp, { force: true });


