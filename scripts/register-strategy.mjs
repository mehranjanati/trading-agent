#!/usr/bin/env node
// register-strategy.mjs — the EXPLICIT, human-gated promotion step.
//
// WHY IT IS SEPARATE FROM THE PIPELINE: ADR-009 rejected "auto-promote on build
// pass" — building and verifying must never be the same decision as publishing.
// So the pipeline produces a verified artifact + manifest, and THIS script is
// the one a human runs, with an explicit --activate, to make the watcher willing
// to load those bytes:
//
//   default      copy artifact + manifest into the registry dir, print the row
//                (nothing about the running watcher changes — a dry promotion)
//   --activate   also append the registry.json row, which is what actually makes
//                the version selectable after the next Registry.Reload
//
// It refuses to overwrite a published id@version (ADR-009: "overwrite of
// published version rejected") — new behaviour is a NEW version.
//
// usage: node scripts/register-strategy.mjs --manifest go-watcher/strategies/build/x-0.1.0.manifest.json [--activate]
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_DIR = join(ROOT, "go-watcher", "strategies", "samples");
const VER_RE = /^\d+\.\d+\.\d+$/;

function fail(msg) {
  console.error(`register-strategy: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { activate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--activate") out.activate = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else fail(`unknown argument ${a}`);
  }
  return out;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/register-strategy.mjs --manifest <path.manifest.json> [--activate]");
    return;
  }
  if (!args.manifest) fail("--manifest is required");

  const manifestPath = resolve(ROOT, args.manifest);
  if (!existsSync(manifestPath)) fail(`${args.manifest} not found`);
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!man.id || !VER_RE.test(String(man.version ?? ""))) fail("manifest must carry id and an x.y.z version");
  if (!man.sha256) fail("manifest has no sha256 — run scripts/strategy-pipeline.mjs to produce one");
  // An unverified artifact is exactly what ADR-009 forbids from being published.
  if (man.verified === false) fail(`${man.id}@${man.version} was built with --skip-verify; verify it before registering`);

  const artifactSrc = join(dirname(manifestPath), man.artifact ?? `${man.id}-${man.version}.wasm`);
  if (!existsSync(artifactSrc)) fail(`artifact ${artifactSrc} not found next to the manifest`);
  const bytes = readFileSync(artifactSrc);
  const digest = sha256(bytes);
  // The manifest is the only record of what was verified; if the bytes moved
  // underneath it, verification proves nothing about THIS file.
  if (digest !== man.sha256) {
    fail(`artifact sha256 ${digest} != manifest ${man.sha256} — the file changed after verification`);
  }

  const registryPath = join(REGISTRY_DIR, "registry.json");
  const rows = JSON.parse(readFileSync(registryPath, "utf8"));
  const key = `${man.id}@${man.version}`;
  if (rows.some((r) => `${r.id}@${r.version}` === key)) {
    fail(`${key} is already published — versions are immutable (ADR-011): bump the version instead of overwriting`);
  }

  const artifactName = `${man.id}-${man.version}.wasm`;

  const row = {
    id: man.id,
    version: man.version,
    file: artifactName,
    name: man.name ?? man.id,
    description: man.description ?? "",
    configuration: man.configuration ?? {},
  };

  if (!args.activate) {
    console.log(`${key} verified (sha256 ${man.sha256.slice(0, 16)}…) and publishable.`);
    console.log("registry.json unchanged and nothing copied — a dry promotion must leave the publish dir untouched.\n");
    console.log("row to publish (re-run with ACTIVATE=1 to copy the artifact and append it):");
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  // Copy only on the real promotion: the registry dir is what the watcher
  // deploys, so it must contain published artifacts only — never a candidate.
  copyFileSync(artifactSrc, join(REGISTRY_DIR, artifactName));
  copyFileSync(manifestPath, join(REGISTRY_DIR, artifactName.replace(/\.wasm$/, ".manifest.json")));

  // Keep the catalog order the loader renders (registry.go list(): id, version)
  // so a diff of registry.json reads as "one line added", never a reshuffle.
  rows.push(row);
  rows.sort((a, b) => (a.id === b.id ? String(a.version).localeCompare(String(b.version)) : String(a.id).localeCompare(String(b.id))));
  writeFileSync(registryPath, JSON.stringify(rows, null, 2) + "\n");

  console.log(`published ${key} (${man.sha256.slice(0, 16)}…)`);
  console.log("  registry.json updated — reload the watcher (:reload) to make it selectable");
  console.log("  next: go -C go-watcher run ./cmd/analyze-live -symbol BTCUSDT -strategies " + key);
}

main();
