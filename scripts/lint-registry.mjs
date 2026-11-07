#!/usr/bin/env node
// lint-registry.mjs — integrity of the published artifact set (ADR-009 supply chain).
//
// WHY IT EXISTS: `registry.json` is the ONE place that decides which strategy
// bytes the watcher is allowed to execute, and until now nothing validated it —
// a typo'd filename or a hand-edited row only surfaced when the watcher failed
// to boot (Registry.Reload fails closed on a missing file). This linter runs in
// CI on every PR, so a broken row is caught at review time instead of at deploy.
//
// What it enforces (hard errors):
//   - unique id@version (a duplicate row silently shadows the first)
//   - id shape + semver version + non-empty file
//   - the artifact exists, is non-empty, and is under the 16 MB loader cap
//   - status is active|retired (registry.go rejects anything else at load)
//   - if a <artifact>.manifest.json sidecar exists, its sha256/id/version match
//
// What it warns about (provenance, ADR-009):
//   - a missing manifest sidecar, or one without toolchain/built_at/source_hash
//     (the four pre-existing sample artifacts are backfilled)
//
// Usage: node scripts/lint-registry.mjs [--dir go-watcher/strategies/samples]
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_WASM_BYTES = 16 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const STATUSES = new Set(["active", "retired"]);
const PROVENANCE_FIELDS = ["go_version", "built_at", "source_sha256", "build_flags"];

/** sha256Hex — the digest the registry loader computes (registry.go Reload). */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** lintRegistry validates one registry dir. Returns {errors, warnings, rows}. */
export function lintRegistry(dir) {
  const errors = [];
  const warnings = [];
  const manifestPath = join(dir, "registry.json");
  if (!existsSync(manifestPath)) {
    return { errors: [`registry.json not found in ${dir}`], warnings, rows: 0 };
  }
  let rows;
  try {
    rows = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { errors: [`registry.json is not valid JSON: ${e.message}`], warnings, rows: 0 };
  }
  if (!Array.isArray(rows)) {
    return { errors: ["registry.json must be an array of rows"], warnings, rows: 0 };
  }

  const seen = new Set();
  // digestOwner maps an artifact sha256 to the first id@version that shipped it,
  // so two rows pointing at the SAME bytes are visible. That is legal (a version
  // may differ from its predecessor only by `configuration`), but it must be
  // stated: sma-cross 0.1.0 and 0.2.0 are byte-identical today, and without this
  // warning nobody could tell "new code" from "new defaults".
  const digestOwner = new Map();
  for (const [i, row] of rows.entries()) {
    const at = `row ${i} (${row?.id ?? "?"}@${row?.version ?? "?"})`;
    if (!row || typeof row !== "object") {
      errors.push(`${at}: not an object`);
      continue;
    }
    const id = String(row.id ?? "");
    const version = String(row.version ?? "");
    const file = String(row.file ?? "");

    if (!ID_RE.test(id)) errors.push(`${at}: id must match ${ID_RE}`);
    if (!VER_RE.test(version)) errors.push(`${at}: version must be x.y.z`);
    if (!file) errors.push(`${at}: file is required`);
    // A duplicate id@version shadows the earlier row at load — the classic
    // copy-paste mistake when publishing a new version by hand.
    const key = `${id}@${version}`;
    if (seen.has(key)) errors.push(`${at}: duplicate id@version`);
    seen.add(key);

    const status = String(row.status ?? "").trim();
    if (status && !STATUSES.has(status)) {
      errors.push(`${at}: status "${status}" must be active|retired (registry.go rejects it at load)`);
    }
    if (status === "retired" && !String(row.retired_reason ?? "").trim()) {
      warnings.push(`${at}: retired without a retired_reason (the dashboard cannot say WHY)`);
    }

    const artifact = join(dir, file);
    if (!file || !existsSync(artifact)) {
      errors.push(`${at}: artifact ${file} does not exist`);
      continue;
    }
    const bytes = readFileSync(artifact);
    if (bytes.length === 0) {
      errors.push(`${at}: artifact ${file} is empty`);
      continue;
    }
    if (bytes.length > MAX_WASM_BYTES) {
      errors.push(`${at}: artifact ${file} is ${bytes.length} bytes, over the ${MAX_WASM_BYTES} loader cap`);
    }

    const sidecar = join(dir, file.replace(/\.wasm$/, "") + ".manifest.json");
    if (!existsSync(sidecar)) {
      warnings.push(`${at}: no manifest sidecar — provenance (sha256/toolchain) unrecorded`);
      continue;
    }
    let man;
    try {
      man = JSON.parse(readFileSync(sidecar, "utf8"));
    } catch (e) {
      errors.push(`${at}: manifest ${sidecar} is not valid JSON: ${e.message}`);
      continue;
    }
    const digest = sha256Hex(bytes);
    const owner = digestOwner.get(digest);
    if (owner) {
      warnings.push(`${at}: artifact is byte-identical to ${owner} — the version differs only by configuration`);
    } else {
      digestOwner.set(digest, key);
    }
    if (String(man.sha256 ?? "") !== digest) {
      errors.push(`${at}: manifest sha256 ${man.sha256 ?? "(absent)"} != artifact ${digest} — artifact replaced after it was recorded`);
    }
    if (String(man.id ?? "") !== id || String(man.version ?? "") !== version) {
      errors.push(`${at}: manifest id/version ${man.id ?? "?"}@${man.version ?? "?"} does not match the registry row`);
    }
    // Backfilled manifests (the four pre-existing samples) know their sha256 and
    // source hash but not their toolchain/built_at; that gap is recorded rather
    // than re-warned on every run.
    const missing = man.provenance === "backfilled"
      ? []
      : PROVENANCE_FIELDS.filter((f) => !man[f]);
    if (missing.length) {
      warnings.push(`${at}: manifest is missing ${missing.join(", ")}`);
    }
  }
  return { errors, warnings, rows: rows.length };
}

function main() {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf("--dir");
  const dir = dirFlag >= 0 && args[dirFlag + 1]
    ? join(ROOT, args[dirFlag + 1])
    : join(ROOT, "go-watcher", "strategies", "samples");

  const { errors, warnings, rows } = lintRegistry(dir);
  for (const w of warnings) console.warn(`warn  ${w}`);
  for (const e of errors) console.error(`FAIL  ${e}`);
  if (errors.length) {
    console.error(`\nregistry-lint: FAIL (${errors.length} error(s), ${rows} row(s))`);
    process.exit(1);
  }
  console.log(`registry-lint: OK (${rows} row(s), ${warnings.length} warning(s))`);
}

if (process.argv[1] && process.argv[1].endsWith("lint-registry.mjs")) {
  main();
}

