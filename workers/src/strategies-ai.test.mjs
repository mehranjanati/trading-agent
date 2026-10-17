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
import { extractGoCode, validateGoCode, SYSTEM_PROMPT, buildGeneratePrompt, extractCodeBlocks } from "./strategies-ai.mjs";
import { CORS, corsFor, BROWSER_POST_PATHS } from "./errors.mjs";
import { TEMPLATE_MAIN } from "./strategies-template.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chain = ["migrations/0001_init.sql", "migrations/0002_schema.sql", "migrations/0003_seed.sql", "migrations/0004_strategy_drafts.sql", "migrations/0005_chat_attachments.sql"]
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

  it("prefers the LONGEST go fence (reasoning models emit several)", () => {
    const text = "thinking...\n```go\nfunc x() {}\n```\nfinal:\n```go\n" + GOOD_CODE + "\n```\n";
    assert.equal(extractGoCode(text), GOOD_CODE);
    // Bare fences are only considered when no go fence exists at all.
    assert.equal(extractGoCode("```\nshort\n```\n```\n" + GOOD_CODE + "\n```"), GOOD_CODE);
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

  it("DRIFT GUARD: the bundled TEMPLATE_MAIN equals go-watcher/strategies/template/main.go", () => {
    const tpl = readFileSync(join(ROOT, "go-watcher", "strategies", "template", "main.go"), "utf8");
    assert.equal(TEMPLATE_MAIN, tpl, "regenerate workers/src/strategies-template.mjs from the template");
  });

  it("the default prompt embeds the envelope so the model only writes decide()", () => {
    const p = buildGeneratePrompt({ description: "d", strategy_id: "x-1", version: "0.1.0", templateMain: TEMPLATE_MAIN });
    assert.ok(p.includes("func decide(inv invocation)"));
    assert.ok(p.includes("StrategyID") && p.includes("DeadlineMs"));
    assert.ok(p.includes("/no_think"));
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

  it("two-shot: falls back to the strong model when the fast one fails validation", async () => {
    const bad = GOOD_CODE.replace('import (', 'import (\n\t"net/http"');
    // Fast model returns banned code; fallback returns valid code.
    const env = freshEnv({
      AI_MODEL: "fast-model",
      AI_MODEL_FALLBACK: "strong-model",
      AI: { run: async (m) => (m === "fast-model" ? "```go\n" + bad + "\n```" : "```go\n" + GOOD_CODE + "\n```") },
    });
    const r = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "two-shot", strategy_id: "two-shot", version: "0.1.0" }));
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.model, "strong-model");
    assert.equal(body.attempts, 2);
    // The fast model's rejected attempt is still on the trail.
    const rows = sqlJson(`SELECT model, status FROM strategy_drafts WHERE strategy_id='two-shot' ORDER BY created_at;`);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].status.startsWith("rejected"));
    assert.equal(rows[1].status, "generated");
  });

  it("two-shot: both models failing records a rejected draft and 400", async () => {
    const env = freshEnv({
      AI_MODEL: "fast-model",
      AI_MODEL_FALLBACK: "strong-model",
      AI: { run: async () => "no code at all" },
    });
    const r = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "d", strategy_id: "both-fail", version: "0.1.0" }));
    assert.equal(r.status, 400);
    const rows = sqlJson(`SELECT status FROM strategy_drafts WHERE strategy_id='both-fail';`);
    assert.ok(rows.length >= 1 && rows[0].status.startsWith("rejected"));
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

  // A draft you no longer want must be discardable — but the row stays in D1
  // (status 'deleted'), because a row that simply vanishes is unauditable. Same
  // rule as the watch FSM: transition, never delete (docs/05 §5.3).
  it("POST /api/strategy:draft:delete discards a draft, keeps the row, hides it from the list", async () => {
    const env = freshEnv({ AI: fakeAI("```go\n" + GOOD_CODE + "\n```") });
    const gen = await post(app, env, "/api/strategy:generate",
      JSON.stringify({ description: "d2", strategy_id: "draft-drop", version: "0.1.0" }));
    const { id } = await gen.json();
    assert.ok(id);

    const del = await app.fetch(new Request("http://x/api/strategy:draft:delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader" },
      body: JSON.stringify({ id }),
    }), env);
    assert.equal(del.status, 200);
    const out = await del.json();
    assert.equal(out.status, "deleted");
    assert.equal(out.kept_for_audit, true);

    // The row is still there (audit trail), the list no longer shows it.
    const rows = sqlJson(`SELECT status FROM strategy_drafts WHERE id='${id}';`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "deleted");
    const listed = await (await app.fetch(new Request("http://x/api/strategy:drafts"), env)).json();
    assert.ok(!listed.drafts.some((d) => d.id === id));

    // Idempotent: discarding twice answers 200 with `already`, never an error.
    const again = await app.fetch(new Request("http://x/api/strategy:draft:delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader" },
      body: JSON.stringify({ id }),
    }), env);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).already, true);
  });

  it("POST /api/strategy:draft:delete validates the id and gates the role", async () => {
    const env = freshEnv({});
    const noId = await app.fetch(new Request("http://x/api/strategy:draft:delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader" },
      body: JSON.stringify({}),
    }), env);
    assert.equal(noId.status, 400);

    const missing = await app.fetch(new Request("http://x/api/strategy:draft:delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "trader" },
      body: JSON.stringify({ id: "dr_nope" }),
    }), env);
    assert.equal(missing.status, 404);

    const denied = await app.fetch(new Request("http://x/api/strategy:draft:delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": "viewer" },
      body: JSON.stringify({ id: "dr_nope" }),
    }), env);
    assert.equal(denied.status, 403);
  });

  it("the draft-delete path is in the browser POST allow-list (advisory only)", () => {
    assert.ok(BROWSER_POST_PATHS.has("/api/strategy:draft:delete"));
    // ...and the order/approval paths stay out of it (D-08).
    assert.ok(!BROWSER_POST_PATHS.has("/api/orders:intents"));
    assert.ok(!BROWSER_POST_PATHS.has("/api/approvals"));
  });
});

describe("strategies-ai — POST /api/strategy:chat:stream (SSE passthrough)", () => {
  const SSE = 'data: {"response":"hello "}\n\ndata: {"response":"world"}\n\ndata: [DONE]\n\n';

  it("200 text/event-stream, x-ai-model header, frames pass through untouched", async () => {
    const env = freshEnv({ AI_MODEL: "test-model", AI: { run: async () => SSE } });
    const r = await post(app, env, "/api/strategy:chat:stream",
      JSON.stringify({ messages: [{ role: "user", content: "hi" }], principles: "Max risk 2%" }));
    assert.equal(r.status, 200);
    assert.ok((r.headers.get("content-type") ?? "").includes("text/event-stream"));
    // The Go chat client reads this header to report which model answered.
    assert.equal(r.headers.get("x-ai-model"), "test-model");
    const text = await r.text();
    assert.ok(text.includes('"response":"hello "'), text);
    assert.ok(text.includes("[DONE]"), text);
  });

  it("principles become a system turn and /no_think rides the last user turn", async () => {
    let seen = null;
    const env = freshEnv({
      AI: { run: async (_m, opts) => { seen = opts; return SSE; } },
    });
    await post(app, env, "/api/strategy:chat:stream", JSON.stringify({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      principles: "Never exceed 2% risk",
    }));
    assert.equal(seen.stream, true);
    assert.equal(seen.messages[0].role, "system");
    assert.ok(seen.messages[0].content.includes("Never exceed 2% risk"));
    assert.ok(seen.messages.at(-1).content.endsWith("/no_think"));
    assert.equal(seen.messages.length, 4); // 1 system + 3 history
  });

  it("400 VALIDATION on an empty messages array (no AI call)", async () => {
    let called = false;
    const env = freshEnv({ AI: { run: async () => { called = true; return SSE; } } });
    const r = await post(app, env, "/api/strategy:chat:stream", JSON.stringify({ messages: [] }));
    assert.equal(r.status, 400);
    assert.equal(called, false);
  });

  it("503 DEGRADED without the AI binding", async () => {
    const env = freshEnv();
    const r = await post(app, env, "/api/strategy:chat:stream",
      JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    assert.equal(r.status, 503);
  });

  it("403 for a role outside trader/operator/admin", async () => {
    const env = freshEnv({ AI: { run: async () => SSE } });
    const r = await post(app, env, "/api/strategy:chat:stream",
      JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), { "x-role": "viewer" });
    assert.equal(r.status, 403);
  });

  it("advisory stream path is browser-POST allowed (D-08 surface unchanged)", () => {
    assert.ok(BROWSER_POST_PATHS.has("/api/strategy:chat:stream"));
    assert.ok(!BROWSER_POST_PATHS.has("/api/orders:intents"));
  });
});

describe("browser CORS allow-list (fail closed on order paths)", () => {
  const req = (method, path, acrm) =>
    new Request(`http://x${path}`, { method, headers: acrm ? { "access-control-request-method": acrm } : {} });

  it("preflight for POST on advisory paths carries allow-methods: POST", () => {
    for (const p of ["/api/strategy:generate", "/api/strategy:chat", "/api/strategy:draft", "/api/watches"]) {
      const h = corsFor(req("OPTIONS", p, "POST"));
      assert.ok(h["access-control-allow-methods"].includes("POST"), p);
    }
  });

  it("preflight for POST on non-whitelisted paths fails closed", () => {
    for (const p of ["/api/orders:intents", "/api/approvals", "/api/kill-switch", "/api/strategy:activate", "/api/lease:handoff", "/api/health"]) {
      assert.ok(!BROWSER_POST_PATHS.has(p), p);
      const h = corsFor(req("OPTIONS", p, "POST"));
      assert.ok(!h["access-control-allow-methods"].includes("POST"), p);
    }
  });

  it("preflight not asking for POST keeps the reads-only list", () => {
    const h = corsFor(req("OPTIONS", "/api/strategy:chat", "GET"));
    assert.ok(!h["access-control-allow-methods"].includes("POST"));
  });

  it("plain GET keeps the reads-only list even on advisory paths", () => {
    const h = corsFor(req("GET", "/api/strategy:chat"));
    assert.ok(!h["access-control-allow-methods"].includes("POST"));
    assert.equal(h["access-control-allow-origin"], CORS["access-control-allow-origin"]);
  });

  it("OPTIONS preflight end-to-end returns 204 with POST on advisory paths", async () => {
    const env = freshEnv();
    const app0 = app;
    for (const p of ["/api/strategy:chat", "/api/strategy:generate"]) {
      const r = await app0.fetch(req("OPTIONS", p, "POST"), env);
      assert.equal(r.status, 204);
      assert.ok((r.headers.get("access-control-allow-methods") ?? "").includes("POST"), p);
    }
    const r = await app0.fetch(req("OPTIONS", "/api/orders:intents", "POST"), env);
    assert.equal(r.status, 204);
    assert.ok(!(r.headers.get("access-control-allow-methods") ?? "").includes("POST"));
  });

  it("extractCodeBlocks finds every fence with its language", () => {
    const text = "a\n```go\npackage main\n```\nb\n```python\nprint(1)\n```\nc\n```\nplain\n```";
    const blocks = extractCodeBlocks(text);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].language, "go");
    assert.ok(blocks[0].code.includes("package main"));
    assert.equal(blocks[1].language, "python");
    assert.equal(blocks[2].language, "text");
    assert.deepEqual(extractCodeBlocks("no fences"), []);
  });
});

describe("strategies-ai — chart-image turns (ADR-010)", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const SSE = 'data: {"response":"ok"}\n\ndata: [DONE]\n\n';
  const chartTurn = (text = "read this chart") => ({
    id: "msg-uuid-9",
    role: "user",
    content: [{ type: "text", text }, { type: "image_url", image_url: { url: PNG, detail: "low" } }],
  });

  // visionEnv captures the run() options and every R2 put.
  function visionEnv(extra = {}) {
    const puts = [];
    let seen = null;
    const env = freshEnv({
      AI_VISION_MODEL: "@cf/qwen/qwen3.8-27b",
      AI: { run: async (_m, opts) => { seen = opts; return SSE; } },
      CHAT_MEDIA: { put: async (k, b, o) => { puts.push({ k, len: b.length, type: o?.httpMetadata?.contentType }); } },
      ...extra,
    });
    return { env, puts, seen: () => seen };
  }

  it("routes a chart turn to the vision model, /no_think on the TEXT part", async () => {
    const { env, seen } = visionEnv();
    const r = await post(app, env, "/api/strategy:chat:stream",
      JSON.stringify({ session_id: "chat_1_x", messages: [chartTurn()] }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-ai-model"), "@cf/qwen/qwen3.8-27b");
    assert.equal(r.headers.get("x-ai-vision"), "1");
    const msgs = seen().messages;
    const last = msgs.at(-1);
    assert.ok(Array.isArray(last.content));
    assert.equal(last.content[0].text, "read this chart\n/no_think");
    assert.equal(last.content[1].type, "image_url");
    // The regression this PR fixes: a plain `+=` on array content.
    assert.ok(!JSON.stringify(msgs).includes("[object Object]"));
    // Top-level enable_thinking:false rides along for a Qwen vision model
    // (live tail 2026-10-14: reasoning_effort + chat_template_kwargs do NOT
    // stop the thinking trace — content comes back null).
    assert.equal(seen().enable_thinking, false);
    assert.equal(seen().reasoning_effort, undefined);
    assert.equal(seen().chat_template_kwargs, undefined);
  });

  it("persists the chart bytes to R2 and the metadata row to D1", async () => {
    const { env, puts } = visionEnv();
    const r = await post(app, env, "/api/strategy:chat:stream",
      JSON.stringify({ session_id: "chat_1_x", messages: [chartTurn()] }));
    assert.equal(r.headers.get("x-chat-attachments"), "1");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].len, 70);
    assert.equal(puts[0].type, "image/png");
    assert.ok(puts[0].k.startsWith("chat/chat_1_x/msg-uuid-9/"));
    const rows = sqlJson(`SELECT message_id, session_id, media_type, bytes, r2_key FROM chat_attachments;`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message_id, "msg-uuid-9");
    assert.equal(rows[0].session_id, "chat_1_x");
    assert.equal(rows[0].media_type, "image/png");
    assert.equal(rows[0].bytes, 70);
  });

  it("a text-only turn keeps the text model and sends no enable_thinking switch (plain-model is not Qwen)", async () => {
    const { env, seen, puts } = visionEnv({ AI_MODEL: "plain-model" });
    const r = await post(app, env, "/api/strategy:chat:stream",
      JSON.stringify({ messages: [{ role: "user", content: "just text" }] }));
    assert.equal(r.headers.get("x-ai-model"), "plain-model");
    assert.equal(r.headers.get("x-ai-vision"), null);
    assert.equal(r.headers.get("x-chat-attachments"), null);
    assert.equal(seen().enable_thinking, undefined);
    assert.equal(puts.length, 0);
    assert.equal(seen().messages.at(-1).content, "just text\n/no_think");
  });

  it("the REST :chat route answers a chart turn with vision:true", async () => {
    const { env } = visionEnv();
    const r = await post(app, env, "/api/strategy:chat",
      JSON.stringify({ session_id: "chat_1_x", messages: [chartTurn()] }));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.model, "@cf/qwen/qwen3.8-27b");
    assert.equal(body.vision, true);
    assert.equal(body.attachments, 1);
  });

  it("a saved draft records the turn id that produced it", async () => {
    const { env } = visionEnv();
    const r = await post(app, env, "/api/strategy:draft",
      JSON.stringify({ strategy_id: "chart-draft", version: "0.1.0", code: "package main", prompt: "chart?", message_id: "msg-uuid-9" }));
    assert.equal(r.status, 201);
    const rows = sqlJson(`SELECT message_id FROM strategy_drafts WHERE strategy_id='chart-draft';`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message_id, "msg-uuid-9");
  });

  it("a text-only draft leaves message_id NULL", async () => {
    const { env } = visionEnv();
    await post(app, env, "/api/strategy:draft",
      JSON.stringify({ strategy_id: "text-draft", version: "0.1.0", code: "package main" }));
    const rows = sqlJson(`SELECT message_id FROM strategy_drafts WHERE strategy_id='text-draft';`);
    assert.equal(rows[0].message_id, null);
  });
});