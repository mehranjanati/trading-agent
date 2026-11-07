#!/usr/bin/env node
// strategy-pipeline.mjs — the ONE entrypoint that turns strategy source into a
// verified artifact. Local runs and CI both call THIS; neither reimplements it.
//
// WHY IT EXISTS: before this, "add a strategy" was a sequence of manual steps
// (copy the template, run make strategy-build, hand-edit registry.json) where
// the only automated check was `go build` — it proved the code COMPILES, never
// that it speaks the contract. A strategy that panics on a missing config key
// compiled fine and failed in production. This script closes that gap:
//
//   1. build     GOOS=wasip1 GOARCH=wasm, same flags CI uses
//   2. verify    go run ./cmd/strategy-check  (golden + failure shapes)
//   3. manifest  sha256, source hash, toolchain, build flags, built_at (ADR-009)
//
// It deliberately does NOT touch registry.json: promotion is a human decision
// (ADR-009 rejects auto-promote on build pass). `register-strategy.mjs` is the
// separate, explicit step — see `make strategy-register`.
//
// usage:
//   node scripts/strategy-pipeline.mjs --src strategies/dev/my-strat \
//     --id my-strat --version 0.1.0 [--out go-watcher/strategies/build] [--skip-verify]
//
// exit codes: 0 = built + verified, 1 = build/verify failed, 2 = bad usage.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GO_WATCHER = join(ROOT, "go-watcher");
const ID_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
// BUILD_FLAGS is recorded verbatim in the manifest so a later rebuild can be
// compared field by field (ADR-009: "reproducible wasip1 compile log").
const BUILD_FLAGS = 'GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 -trimpath -ldflags="-s -w"';

function fail(msg) {
  console.error(`strategy-pipeline: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { out: "go-watcher/strategies/build", verify: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--src") out.src = argv[++i];
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--version") out.version = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--skip-verify") out.verify = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else fail(`unknown argument ${a}`);
  }
  return out;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/strategy-pipeline.mjs --src <dir> --id <id> --version <x.y.z> [--out <dir>] [--skip-verify]");
    return;
  }
  if (!args.src || !args.id || !args.version) fail("--src, --id and --version are required");
  if (!ID_RE.test(args.id)) fail(`id "${args.id}" must match ${ID_RE}`);
  if (!VER_RE.test(args.version)) fail(`version "${args.version}" must be x.y.z`);

  const src = resolve(ROOT, args.src);
  const mainGo = join(src, "main.go");
  const goMod = join(src, "go.mod");
  if (!existsSync(mainGo)) fail(`${mainGo} not found — is --src a strategy module dir?`);
  if (!existsSync(goMod)) {
    fail(`${goMod} not found — a strategy is a STANDALONE module (own go.mod, stdlib only), never part of go-watcher/`);
  }

  const outDir = resolve(ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const artifactName = `${args.id}-${args.version}.wasm`;
  const artifactPath = join(outDir, artifactName);

  // 1. build — the exact flags the Makefile and CI use, so a rebuild matches.
  console.log(`[1/3] build   ${args.id}@${args.version}`);
  try {
    execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", artifactPath, "."], {
      cwd: src,
      stdio: "inherit",
      env: { ...process.env, GOOS: "wasip1", GOARCH: "wasm", CGO_ENABLED: "0" },
    });
  } catch {
    fail("go build failed (see the compiler output above)");
  }
  const wasmBytes = readFileSync(artifactPath);
  if (!wasmBytes.length) fail(`artifact ${artifactPath} is empty`);

  // 2. verify — run the real bytes through the real runner. This is the gate a
  // regex could never provide: the guest must echo its ids, keep confidence in
  // [0,1], and degrade (never fault) on the shapes production actually sends.
  if (args.verify) {
    console.log(`[2/3] verify  ${artifactName}`);
    try {
      execFileSync("go", ["run", "./cmd/strategy-check", "-wasm", artifactPath, "-id", args.id, "-version", args.version], {
        cwd: GO_WATCHER,
        stdio: "inherit",
      });
    } catch {
      fail(`contract verification FAILED for ${artifactName} — the artifact was built but must not be registered`);
    }
  } else {
    console.log("[2/3] verify  SKIPPED (--skip-verify) — never register an unverified artifact");
  }

  // 3. manifest — ADR-009 provenance: what bytes, from what source, with what
  // toolchain. Written next to the artifact so register/lint can both read it.
  console.log("[3/3] manifest");
  const goVersion = execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim();
  const manifest = {
    id: args.id,
    version: args.version,
    artifact: artifactName,
    sha256: sha256(wasmBytes),
    contract_version: "1",
    bytes: wasmBytes.length,
    go_version: goVersion,
    build_flags: BUILD_FLAGS,
    built_at: new Date().toISOString(),
    source_sha256: sha256(readFileSync(mainGo)),
    source_path: args.src,
    verified: args.verify,
  };
  const manifestPath = artifactPath.replace(/\.wasm$/, ".manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\n  artifact  ${artifactPath}`);
  console.log(`  manifest  ${manifestPath}`);
  console.log(`  sha256    ${manifest.sha256}`);
  console.log("\nnext (explicit, human-gated — ADR-009 rejects auto-promote):");
  console.log(`  make strategy-register MANIFEST=${manifestPath.replace(ROOT + "/", "")}`);
}

main();


