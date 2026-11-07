#!/usr/bin/env node
// strategy-verify-all.mjs — CI entrypoint: build + contract-verify EVERY
// strategy module under strategies/dev/.
//
// WHY IT EXISTS: a PR that edits a strategy's decide() must be rejected by CI if
// the new code faults on a missing config key or stops echoing its ids. This is
// the job that catches that, and it deliberately calls the SAME pipeline a human
// runs locally (scripts/strategy-pipeline.mjs) instead of reimplementing it —
// one definition of "verified", used by both.
//
// A repo with no dev modules is NOT an error (nothing to verify yet).
//
// usage: node scripts/strategy-verify-all.mjs [--dir strategies/dev]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf("--dir");
  const rel = dirFlag >= 0 && args[dirFlag + 1] ? args[dirFlag + 1] : "strategies/dev";
  const base = join(ROOT, rel);

  if (!existsSync(base)) {
    console.log(`strategy-verify-all: no ${rel}/ yet — nothing to verify`);
    return;
  }

  const modules = readdirSync(base)
    .filter((name) => !name.startsWith("."))
    .map((name) => ({ name, path: join(base, name) }))
    .filter((m) => statSync(m.path).isDirectory())
    .filter((m) => existsSync(join(m.path, "main.go")));

  if (!modules.length) {
    console.log(`strategy-verify-all: ${rel}/ has no strategy modules — nothing to verify`);
    return;
  }

  const failures = [];
  for (const m of modules) {
    const metaPath = join(m.path, "strategy.json");
    let id = m.name;
    let version = "0.1.0";
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        id = String(meta.id ?? id);
        version = String(meta.version ?? version);
      } catch (e) {
        failures.push(`${m.name}: strategy.json is not valid JSON (${e.message})`);
        continue;
      }
    }
    try {
      execFileSync("node", [join(ROOT, "scripts", "strategy-pipeline.mjs"),
        "--src", join(rel, m.name), "--id", id, "--version", version], { stdio: "inherit" });
    } catch {
      failures.push(`${id}@${version} (${rel}/${m.name})`);
    }
  }

  if (failures.length) {
    console.error(`\nstrategy-verify-all: FAIL (${failures.length}/${modules.length})`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`\nstrategy-verify-all: OK (${modules.length} module(s))`);
}

main();
