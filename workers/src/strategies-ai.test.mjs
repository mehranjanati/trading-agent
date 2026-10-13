// strategies-ai.test.mjs — AI strategy code generation (chat → Go draft).
// Acceptance frame: (1) a valid fenced Go program becomes a REVIEW-ONLY draft
// with status 'generated'; (2) any contract breach (no fence, banned import,
// missing package main, unbalanced braces) is a VALIDATION rejection with a
// rejected draft recorded; (3) the AI binding is required (DEGRADED without);
// (4) RBAC gates the route; (5) nothing here can execute, build or order —
// drafts are data, and D-08 stays intact.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractGoCode, validateGoCode, SYSTEM_PROMPT, buildGeneratePrompt } from "./strategies-ai.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql"]
  .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
let dbFile;
function sql(q) {
  const tmp = join(tmpdir(), `aiq-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, q);
  try { return execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }); }
  finally { rmSync(tmp, { force: true }); }
}
// sqlJson runs a query in JSON mode (the default `sql` returns pipe format).
function sqlJson(q) {
  const raw = sql(`.mode json\n${q}`);
  const t = raw.trim();
  return t ? JSON.parse(t) : [];
}
function fakeDb() {
  const prep = (stmt) => ({
    _s: stmt, _a: [],
    bind(...a) { this._a = a; return this; },
    _fill() {
      let s = this._s, i = 0;
      return s.replaceAll("?", () => {
        const v = this._a[i++];
        if (v === null || v === undefined) return "NULL";
        return `'${String(v).replaceAll("'", "''")}'`;
      });
    },
    async run() { sql(this._fill()); return {}; },
    async all() {
      if (!/^\s*SELECT/i.test(this._s)) { sql(this._fill()); return { results: [] }; }
      const tmp = join(tmpdir(), `ais-${Date.now()}-${Math.random()}.sql`);
      writeFileSync(tmp, `.mode json\n${this._fill()}`);
      try {
        const raw = execSync(`sqlite3 ${dbFile} < "${tmp}"`, { encoding: "utf8" }).trim();
        return { results: raw ? JSON.parse(raw) : [] };
      } finally { rmSync(tmp, { force: true }); }
    },
  });
  return { prepare: prep, async batch(list) { for (const s of list) await s.run(); } };
}
function freshEnv(extra = {}) {
  dbFile = join(tmpdir(), `ait-${Date.now()}-${Math.random()}.sqlite`);
  const tmp = join(tmpdir(), `aii-${Date.now()}-${Math.random()}.sql`);
  writeFileSync(tmp, chain);
  execSync(`sqlite3 ${dbFile} < "${tmp}"`);
  rmSync(tmp, { force: true });
  return { DB: fakeDb(), ENV: "test", ...extra };
}

// GOOD_CODE is a minimal contract-conformant program (stdlib-allowed imports).
const GOOD_CODE = `package main

import (
\t"encoding/json"
\t"fmt"
\t"os"
\t"strconv"
)

func main() {
\tvar inv map[string]any
\t_ = json.NewDecoder(os.Stdin).Decode(&inv)
\tout := map[string]any{"ok": true}
\t_ = json.NewEncoder(os.Stdout).Encode(out)
\tfmt.Fprintln(os.Stderr, strconv.Itoa(1))
}`;

const fakeAI = (reply) => ({ run: async (_model, _opts) => reply });
const post = (app, env, path, rawBody, headers) =>
  app.fetch(new Request(`http://x${path}`, {
    method: "POST", body: rawBody ?? undefined, headers: { "content-type": "application/json", ...headers },
  }), env);

let app;
before(async () => { app = (await import("./index.mjs")).default; });

describe("strategies-ai — extraction & validation (pure)", () => {
  it("extracts a ```go fence, a bare fence, and null on none", () => {
    assert.equal(extractGoCode("```go\npackage main\n```"), "package main");
    assert.equal(extractGoCode("```\npackage main\n```"), "package main");
    assert.equal(extractGoCode("no fence here"), null);
    assert.equal(extractGoCode(""), null);
    assert.equal(extractGoCode(null), null);
  });

  it("validateGoCode accepts the template-shaped program", () => {
    const tpl = readFileSync(join(ROOT, "go-watcher", "strategies", "template", "main.go"), "utf8");
    assert.deepEqual(validateGoCode(tpl), []);
  });

  it("validateGoCode rejects contract breaches with named reasons", () => {
    assert.ok(validateGoCode("").includes("empty code"));
    assert.ok(validateGoCode(GOOD_CODE.replace("package main", "")).some((p) => p.includes("package main")));
    assert.ok(validateGoCode(GOOD_CODE.replace(/os\.Stdin/g, "x")).some((p) => p.includes("Stdin")));
    assert.ok(validateGoCode(GOOD_CODE.replace(/os\.Stdout/g, "x")).some((p) => p.includes("Stdout")));
    const bad = GOOD_CODE.replace('import (', 'import (\n\t"net/http"');
    assert.ok(validateGoCode(bad).some((p) => p.includes("net/http")));
    assert.ok(validateGoCode(GOOD_CODE + "func x() {").some((p) => p.includes("braces")));
    // A non-allowlisted (but not banned) import is rejected too.
    const extra = GOOD_CODE.replace('"strconv"', '"path/filepath"');
    assert.ok(validateGoCode(extra).some((p) => p.includes("not allowed: path/filepath")));
    // Comments cannot smuggle banned content past the filter.
    assert.deepEqual(validateGoCode("// os.Exit(1) and net/http in a comment\n" + GOOD_CODE), []);
  });

  it("SYSTEM_PROMPT pins the sandbox contract; prompt builder carries ids", () => {
    assert.ok(SYSTEM_PROMPT.includes("package main") && SYSTEM_PROMPT.includes("os.Stdin") && SYSTEM_PROMPT.includes("NO_SIGNAL"));
    const p = buildGeneratePrompt({ description: "rsi divergence", strategy_id: "rsi-div", version: "0.1.0", templateMain: null });
    assert.ok(p.includes("rsi divergence") && p.includes("rsi-div") && p.includes("0.1.0"));
  });
});

describe("strategies-ai — POST /api/strategy:generate (fake AI)", () => {
  it("201: valid model output becomes a generated draft", async () => {
    const env = freshEnv({ AI: fakeAI("```go\n" + GOOD_CODE + "\n```") });
    const r = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "simple ok program", strategy_id: "simple-ok", version: "0.1.0" }));
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.status, "generated");
    assert.equal(body.strategy_id, "simple-ok");
    const rows = sqlJson(`SELECT strategy_id, status FROM strategy_drafts WHERE id='${body.id}';`);
    assert.equal(rows[0].status, "generated");
  });

  it("400 + rejected draft when the model emits no fence", async () => {
    const env = freshEnv({ AI: fakeAI("I cannot write code today") });
    const r = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "d", strategy_id: "no-fence", version: "0.1.0" }));
    assert.equal(r.status, 400);
    const rows = sqlJson(`SELECT status FROM strategy_drafts WHERE strategy_id='no-fence';`);
    assert.ok(rows[0].status.startsWith("rejected"));
  });

  it("400 + rejected draft on a banned import (net/http)", async () => {
    const bad = GOOD_CODE.replace('import (', 'import (\n\t"net/http"');
    const env = freshEnv({ AI: fakeAI("```go\n" + bad + "\n```") });
    const r = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "d", strategy_id: "banned-imp", version: "0.1.0" }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.message.includes("net/http"));
  });

  it("400 on bad ids and missing description (no AI call, no draft)", async () => {
    const env = freshEnv({ AI: fakeAI("should never be called") });
    for (const body of [
      { description: "", strategy_id: "x1", version: "0.1.0" },
      { description: "d", strategy_id: "Bad ID!", version: "0.1.0" },
      { description: "d", strategy_id: "x1", version: "1.0" },
    ]) {
      const r = await post(app, env, "/api/strategy:generate", JSON.stringify(body));
      assert.equal(r.status, 400);
    }
    const rows = sqlJson(`SELECT COUNT(*) AS n FROM strategy_drafts;`);
    assert.equal(rows[0].n, 0);
  });

  it("403 for a role outside trader/operator/admin", async () => {
    const env = freshEnv({ AI: fakeAI("```go\n" + GOOD_CODE + "\n```") });
    const r = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "d", strategy_id: "rbac", version: "0.1.0" }), { "x-role": "viewer" });
    assert.equal(r.status, 403);
  });

  it("503 DEGRADED without the AI binding", async () => {
    const env = freshEnv();
    const r = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "d", strategy_id: "no-ai", version: "0.1.0" }));
    assert.equal(r.status, 503);
  });

  it("GET /api/strategy:drafts lists recorded drafts", async () => {
    const env = freshEnv({ AI: fakeAI("```go\n" + GOOD_CODE + "\n```") });
    await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "d1", strategy_id: "draft-list", version: "0.1.0" }));
    const r = await app.fetch(new Request("http://x/api/strategy:drafts"), env);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.drafts.some((d) => d.strategy_id === "draft-list"));
  });
});