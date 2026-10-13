// strategies-ai.mjs — AI strategy code generation (chat → Go).
//
// Design: the chat sends a natural-language strategy description; Workers AI
// (no API keys, bound AI) returns Go source constrained to the strategies/
// template contract (package main, stdlib-only, stdin=invocation JSON,
// stdout=result JSON, exit 0). Output is stored as a REVIEW-ONLY draft in
// strategy_drafts — nothing executes, nothing builds, until a human approves.
//
// Guardrails (fail closed):
// - system prompt pins the contract (no os/exit tricks, no imports beyond a
//   strict allowlist, envelope code is fixed text the model must emit).
// - the draft is syntax-checked by a Go-aware heuristic: package main,
//   banned imports (os/exec, net, syscall, plugin, unsafe, cgo), balanced
//   braces backtick-free fence requirement.
// - RBAC: trader+ (same as watches create). D-08 holds: no orders/approvals
//   are reachable from this route.
import { ok, err } from "./errors.mjs";
import { roleOf, guard, readBody } from "./_shared.mjs";

// SYSTEM_PROMPT is the contract the model must obey. Keep tight: every
// allowed import is enumerated, the envelope is verbatim, and any deviation
// is a validation failure on our side (we never trust the model).
export const SYSTEM_PROMPT = `You write trading strategy programs in Go. Output EXACTLY one fenced go code block and nothing else outside it.

HARD RULES (violation = rejected):
1. package main, stdlib imports ONLY from this allowlist: encoding/json, fmt, os, strconv, strings, math, sort, time.
2. FORBIDDEN: os/exec, net/*, syscall, plugin, unsafe, cgo, reflect, runtime, embed, reading files, network, goroutines, init(), os.Exit non-zero on analysis paths.
3. Program shape: read ONE JSON invocation from os.Stdin, write ONE JSON result to os.Stdout, exit 0. On ANY error (unparsable input, missing fields) print a strategy-result ERROR document (status:"ERROR", decision bias FLAT, diagnostics.code:"VALIDATION") to stdout and exit 0. NEVER call os.Exit with any argument other than 0 — os.Exit(1) is FORBIDDEN everywhere, including error paths. Never panic. Analytical unknowns are NO_SIGNAL with bias FLAT, never a crash.
4. Result JSON must match strategy-result-v1: {"contract_version":"1","strategy_id":"<id>","strategy_version":"<version>","invocation_id":"<echo>","status":"SIGNAL|NO_SIGNAL|ERROR","decision":{"bias":"LONG|SHORT|FLAT","confidence":0..1},"signals":[{"kind":"<KIND>","symbol":"<echo>"}] or [],"proposed_state":{},"diagnostics":{"reason":"<human reason>","code":"OK","logs":[]}}.
5. Invocation JSON has market_snapshot {symbol, px, ts, src, candles[]? where each candle is {ts: NUMBER unix millis, open, high, low, close, volume: decimal STRINGS}} and strategy_configuration {} (read params with safe defaults) and previous_state (may carry window[] of decimal strings) and execution_context {asof_ts, deadline_ms, trace_id}.
6. Echo strategy_id/strategy_version/invocation_id from the invocation. Confidence MUST be within [0,1]. Reasons must be short English sentences.
7. Put the strategy logic in func decide(inv invocation) (bias string, conf float64, logs []string). Keep the main() envelope EXACTLY as given by the caller (the caller sends a template main in the prompt when available).
8. No comments about policy. No markdown outside the single go fence.`;

// ALLOWED_IMPORTS is the go/imports allowlist enforced post-generation.
export const ALLOWED_IMPORTS = new Set([
  "encoding/json", "fmt", "os", "strconv", "strings", "math", "sort", "time",
]);

// BANNED_PATTERNS reject obviously-unsafe or out-of-contract code before it
// can become a draft. This is a first-layer filter (defense in depth: the
// sandbox + human review are the real gates), so false positives are
// preferable to false negatives.
const BANNED_PATTERNS = [
  /os\/exec/, /net\/http/, /"net"/, /syscall/, /\bplugin\b/, /\bunsafe\b/,
  /import\s*"C"/, /\breflect\b/, /\bruntime\b/, /go\s+func/, /init\s*\(\s*\)/,
  /os\.Exit\s*\(\s*[1-9]/, /ioutil\./, /os\.(Open|Create|WriteFile|Remove|Mkdir|Chdir|Setenv|Getenv)\s*\(/,
];

export function extractGoCode(text) {
  if (typeof text !== "string" || !text.length) return null;
  // Prefer the first ```go fence; fall back to a bare ``` fence.
  let m = text.match(/```go\s*\n([\s\S]*?)```/);
  if (!m) m = text.match(/```\s*\n([\s\S]*?)```/);
  if (!m) return null;
  return m[1].trim();
}

// stripComments removes Go comments before heuristic checks. This is a
// pre-filter for controlled, generated input (no URLs/strings-with-//
// expected); `go build` remains the real syntax gate.
export function stripComments(src) {
  return String(src ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

export function validateGoCode(code) {
  const problems = [];
  const src = stripComments(code);
  if (!src.trim()) return ["empty code"];
  if (!/package\s+main\b/.test(src)) problems.push("missing `package main`");
  if (!/os\.Stdin/.test(src)) problems.push("must read invocation from os.Stdin");
  if (!/os\.Stdout/.test(src)) problems.push("must write result to os.Stdout");
  // Collect imports: both "x" and (\n"x"\n...) forms — from stripped source
  // so commented-out imports cannot smuggle past the allowlist.
  const imports = new Set();
  const block = src.match(/import\s*\(([\s\S]*?)\)/);
  const collect = (s) => {
    for (const mm of s.matchAll(/"([^"]+)"/g)) imports.add(mm[1]);
  };
  if (block) collect(block[1]);
  for (const mm of src.matchAll(/^import\s+"([^"]+)"/gm)) imports.add(mm[1]);
  for (const imp of imports) {
    if (!ALLOWED_IMPORTS.has(imp)) problems.push(`import not allowed: ${imp}`);
  }
  for (const re of BANNED_PATTERNS) {
    if (re.test(src)) problems.push(`banned pattern: ${re}`);
  }
  // Brace balance (rough syntax sanity; the real check is `go build`).
  let depth = 0;
  for (const ch of src) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push("unbalanced braces");
  return problems;
}

// buildGeneratePrompt assembles the user message: description + ids +
// optional template main (verbatim envelope the model must keep).
export function buildGeneratePrompt({ description, strategy_id, version, templateMain }) {
  let p = `Strategy request: ${description}\nstrategy_id: ${strategy_id}\nstrategy_version: ${version}\n`;
  p += `Emit the full Go program in one go fence. Echo strategy_id/version/invocation_id from the invocation at runtime.\n`;
  if (templateMain) {
    p += `Keep this exact main() envelope and contract types; only write the decide() region:\n\`\`\`go\n${templateMain}\n\`\`\`\n`;
  }
  return p;
}

export function generateRoutes() {
  const safe = (fn) => async (req, env) => {
    try { return await fn(req, env); } catch (e) {
      const { writeErr } = await import("./_shared.mjs");
      return writeErr(e);
    }
  };
  return {
    /** POST /api/strategy:generate — chat → Go draft (review-only). */
    generate: safe(async (req, env) => {
      const g = guard("POST /api/strategy:generate", req);
      if (g) return g;
      const b = await readBody(req);
      const description = String(b.description ?? "").trim();
      const strategy_id = String(b.strategy_id ?? "").trim();
      const version = String(b.version ?? "").trim();
      if (!description || description.length > 4000) {
        const e = new Error("description required (max 4000 chars)"); e.code = "VALIDATION"; throw e;
      }
      if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(strategy_id)) {
        const e = new Error("strategy_id must be [a-z0-9-_]{2,64}"); e.code = "VALIDATION"; throw e;
      }
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        const e = new Error("version must be semver x.y.z"); e.code = "VALIDATION"; throw e;
      }
      if (!env.AI) {
        const e = new Error("AI binding unavailable"); e.code = "DEGRADED"; throw e;
      }
      const model = env.AI_MODEL ?? "@cf/qwen/qwen2.5-coder-32b-instruct";
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildGeneratePrompt({ description, strategy_id, version, templateMain: b.template_main ?? null }) },
      ];
      const aiRes = await env.AI.run(model, { messages, max_tokens: 3072 });
      const text = typeof aiRes === "string" ? aiRes : (aiRes?.response ?? aiRes?.result ?? "");
      const code = extractGoCode(String(text ?? ""));
      if (!code) {
        await recordDraft(env, { strategy_id, version, prompt: description, code: "", model, status: "rejected", actor: roleOf(req), reason: "no go fence in model output" });
        return err("VALIDATION", "model output contained no Go code block", {});
      }
      const problems = validateGoCode(code);
      if (problems.length) {
        await recordDraft(env, { strategy_id, version, prompt: description, code, model, status: "rejected", actor: roleOf(req), reason: problems.join("; ") });
        return err("VALIDATION", "generated code rejected: " + problems.join("; "), {});
      }
      const draft = await recordDraft(env, { strategy_id, version, prompt: description, code, model, status: "generated", actor: roleOf(req) });
      return ok({ id: draft.id, strategy_id, version, code, model, status: "generated" }, 201);
    }),
    /** GET /api/strategy:drafts — list drafts (newest first). */
    drafts: safe(async (req, env) => {
      const rows = await env.DB.prepare(
        "SELECT id, strategy_id, version, prompt, code, model, status, created_by, created_at FROM strategy_drafts ORDER BY created_at DESC LIMIT 50",
      ).all().catch(() => ({ results: [] }));
      return ok({ drafts: rows.results ?? [] });
    }),
  };
}

export async function recordDraft(env, { strategy_id, version, prompt, code, model, status, actor, reason }) {
  const now = new Date().toISOString();
  const id = `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare(
    "INSERT INTO strategy_drafts(id,strategy_id,version,prompt,code,model,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).bind(id, strategy_id, version, prompt, code, model, reason ? `${status}: ${reason}` : status, actor, now).run();
  return { id, at: now };
}
