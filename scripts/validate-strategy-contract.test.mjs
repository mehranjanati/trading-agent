// validate-strategy-contract.test.mjs — E13-T01-S1 regression (node:test, stdlib).
// Guards the golden fixtures, the schema-path rejection contract, and the
// stdlib-only JSON-Schema subset used by scripts/validate-strategy-contract.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate-strategy-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const invSchema = read("schemas/strategy-invocation.schema.json");
const resSchema = read("schemas/strategy-result.schema.json");

describe("E13-T01 strategy contract", () => {
  it("S1: golden request validates against the invocation schema", () => {
    const req = read("schemas/fixtures/strategy-invocation.request.json");
    assert.deepEqual(validate(invSchema, req), []);
  });

  it("S1: golden response validates against the result schema", () => {
    const res = read("schemas/fixtures/strategy-result.response.json");
    assert.deepEqual(validate(resSchema, res), []);
  });

  it("S1: invalid bias is rejected with a schema path", () => {
    const bad = read("schemas/fixtures/strategy-result.response.invalid-bias.json");
    const errs = validate(resSchema, bad);
    assert.ok(errs.length > 0, "expected rejection");
    assert.ok(errs[0].startsWith("$.decision.bias"), `path missing: ${errs[0]}`);
  });

  it("S1: deadline above budget is rejected with a schema path", () => {
    const bad = read("schemas/fixtures/strategy-invocation.request.invalid-deadline.json");
    const errs = validate(invSchema, bad);
    assert.ok(errs.length > 0, "expected rejection");
    assert.match(errs[0], /^\$\.execution_context\.deadline_ms/);
  });

  it("S1: missing required property is reported by path", () => {
    const errs = validate(invSchema, { contract_version: "1" });
    assert.ok(errs.some((e) => e === '$: missing required property "strategy_id"'));
  });

  it("S1: pattern/minLength guards reject malformed ids", () => {
    const res = read("schemas/fixtures/strategy-result.response.json");
    assert.ok(validate(resSchema, { ...res, invocation_id: "junk" }).length > 0);
    assert.ok(validate(invSchema, { ...read("schemas/fixtures/strategy-invocation.request.json"), strategy_id: "" }).length > 0);
  });

  it("S1: runner passes on the manifest and exits 0", () => {
    const out = execFileSync("node", ["scripts/validate-strategy-contract.mjs"], { cwd: ROOT, encoding: "utf8" });
    assert.match(out, /strategy-contract: OK \(4 fixtures, 2 schemas\)/);
  });
});
