// tools.test.mjs — read-only tool catalog for the advisory chat plane (L1).
// Acceptance: (1) TOOL: lines parse (with or without a bullet) and malformed
// JSON is ignored; (2) unknown tools/data-less binds return ok:false, never a
// throw (chat is advisory); (3) the catalog always advertises the D-08 posture
// and the round cap; (4) raw tool syntax never leaks into the answer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolCall,
  stripToolLines,
  runTool,
  toolSystemPrompt,
  MAX_TOOL_ROUNDS,
} from "./tools.mjs";

describe("tools — parseToolCall", () => {
  it("parses a bare TOOL line with JSON args", () => {
    const c = parseToolCall('Checking.\nTOOL: get_prices {"symbols":["BTCUSDT"]}');
    assert.deepEqual(c, { name: "get_prices", args: { symbols: ["BTCUSDT"] } });
  });

  it("tolerates a bullet/indent the model adds", () => {
    assert.deepEqual(parseToolCall('- TOOL: list_drafts {}'), { name: "list_drafts", args: {} });
    assert.deepEqual(parseToolCall('  TOOL: query_state {"domain":"positions"}'),
      { name: "query_state", args: { domain: "positions" } });
  });

  it("returns args {} when the model omits the argument object", () => {
    assert.deepEqual(parseToolCall("TOOL: list_strategies"), { name: "list_strategies", args: {} });
  });

  it("ignores malformed JSON and mid-sentence mentions", () => {
    assert.equal(parseToolCall('TOOL: get_prices {"symbols":'), null);
    assert.equal(parseToolCall("you can call TOOL: x later"), null);
    assert.equal(parseToolCall("no tools here"), null);
    assert.equal(parseToolCall(null), null);
  });
});

describe("tools — stripToolLines", () => {
  it("removes tool lines but keeps the prose answer", () => {
    const text = 'Let me check.\nTOOL: get_prices {"symbols":["BTCUSDT"]}\nBTC is 76138.';
    assert.equal(stripToolLines(text), "Let me check.\nBTC is 76138.");
  });

  it("is safe on empty/non-string input", () => {
    assert.equal(stripToolLines(""), "");
    assert.equal(stripToolLines(undefined), "");
  });
});

describe("tools — runTool is fail-soft and read-only", () => {
  it("unknown tool -> ok:false with a reason (no throw)", async () => {
    const r = await runTool({}, "drop_database", {});
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown tool/);
  });

  it("get_prices without symbols -> ok:false, never a venue call", async () => {
    const r = await runTool({}, "get_prices", { symbols: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /symbols required/);
  });

  it("query_state on a missing D1 -> ok:true with an empty slice (labelled absent)", async () => {
    const r = await runTool({}, "query_state", { domain: "watches" });
    assert.equal(r.ok, true);
    assert.equal(r.data.domain, "watches");
    assert.deepEqual(r.data.data, []);
  });

  it("list_drafts on a missing D1 -> empty list, not a crash", async () => {
    const r = await runTool({}, "list_drafts", {});
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.drafts, []);
  });
});

describe("tools — catalog prompt", () => {
  it("advertises every tool, the round cap, and the never-invent rule", () => {
    const p = toolSystemPrompt();
    for (const name of ["get_prices", "query_state", "list_drafts", "list_strategies"]) {
      assert.ok(p.includes(name), `missing ${name}`);
    }
    assert.ok(p.includes(`max ${MAX_TOOL_ROUNDS} rounds`));
    assert.match(p, /Never invent prices or state/);
  });
});

describe("tools — runWithTools never emits a mid-conversation system (8007)", () => {
  it("the TOOL RESULT turn rides as user, and the head stays a single system", async () => {
    const { runWithTools } = await import("./strategies-ai.mjs");
    const calls = [];
    const env = {
      AI: {
        run: async (_m, opts) => {
          calls.push(opts.messages.map((m) => m.role));
          // First round: the model asks for a tool; second round: final answer.
          return calls.length === 1 ? 'Checking.\nTOOL: list_drafts {}' : { response: "done" };
        },
      },
    };
    const text = await runWithTools({
      env,
      model: "plain-model",
      messages: [
        { role: "system", content: "SYS-A" },
        { role: "system", content: "SYS-B" },
        { role: "user", content: "drafts?" },
      ],
      maxTokens: 64,
    });
    assert.equal(text, "done");
    assert.equal(calls.length, 2);
    // Round 1: leading systems merged into one.
    assert.deepEqual(calls[0], ["system", "user"]);
    // Round 2: assistant TOOL line + TOOL RESULT as USER — still one system.
    assert.deepEqual(calls[1], ["system", "user", "assistant", "user"]);
  });
});
