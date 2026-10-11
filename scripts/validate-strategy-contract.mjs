#!/usr/bin/env node
// validate-strategy-contract.mjs — E13-T01-S1: validate golden WASM strategy
// contract fixtures against schemas/strategy-*.schema.json. Stdlib-only,
// dependency-free subset of JSON Schema draft-07 (same approach as the repo's
// other Node scripts). Usage: node scripts/validate-strategy-contract.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

// validate returns [] when valid, else ["<path>: <message>", ...] (errors carry a schema path).
function validate(schema, data, path = "$", errs = []) {
  if (schema === true || schema === undefined) return errs;
  if (typeof schema.const !== "undefined" && data !== schema.const) {
    errs.push(`${path}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errs.push(`${path}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(data)}`);
  }
  if (typeof schema.type === "string") {
    if (!typeOf(data, schema.type)) errs.push(`${path}: expected ${schema.type}, got ${jsType(data)}`);
  }
  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errs.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errs.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(data)) {
      errs.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }
  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errs.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errs.push(`${path}: above maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(data) && schema.items) {
    data.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errs));
  }
  if (isPlainObject(data)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) errs.push(`${path}: missing required property "${key}"`);
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in data) validate(sub, data[key], `${path}.${key}`, errs);
      }
    }
  }
  return errs;
}

function jsType(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function typeOf(v, t) {
  if (t === "integer") return Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  if (t === "array") return Array.isArray(v);
  if (t === "object") return isPlainObject(v);
  if (t === "null") return v === null;
  return typeof v === t;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// runFixtures drives schemas/fixtures/manifest.json: every expect=ok fixture
// must validate, every expect=fail fixture must be rejected with a path.
function runFixtures() {
  const manifest = read("schemas/fixtures/manifest.json");
  const cache = new Map();
  let failures = 0;
  for (const fx of manifest.fixtures) {
    const schemaKey = `schemas/${fx.schema}`;
    if (!cache.has(schemaKey)) cache.set(schemaKey, read(schemaKey));
    const schema = cache.get(schemaKey);
    const data = read(`schemas/fixtures/${fx.file}`);
    const errs = validate(schema, data);
    const valid = errs.length === 0;
    if (fx.expect === "ok" && !valid) {
      failures++;
      console.error(`FAIL ${fx.file}: expected valid, got ${errs.length} error(s)`);
      errs.forEach((e) => console.error(`      ${e}`));
    } else if (fx.expect === "fail" && valid) {
      failures++;
      console.error(`FAIL ${fx.file}: expected rejection (${fx.reason || "invalid"}) but schema passed`);
    } else if (fx.expect === "fail") {
      const hasPath = errs.some((e) => e.startsWith("$"));
      if (!hasPath) {
        failures++;
        console.error(`FAIL ${fx.file}: rejection lacks a schema path`);
      } else {
        console.log(`ok   ${fx.file}: rejected as expected (${errs[0]})`);
      }
    } else {
      console.log(`ok   ${fx.file}: valid`);
    }
  }
  if (failures) {
    console.error(`strategy-contract: FAIL (${failures} fixture(s))`);
    process.exit(1);
  }
  console.log(`strategy-contract: OK (${manifest.fixtures.length} fixtures, 2 schemas)`);
}

if (process.argv[1] && process.argv[1].endsWith("validate-strategy-contract.mjs")) {
  runFixtures();
}

export { validate };
