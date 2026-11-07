// tools.mjs — read-only tool loop for the advisory chat plane.
//
// The model can ask for live data by emitting exactly one line:
//   TOOL: <name> <json>
// The Worker executes it, appends the result as a user message, and runs
// the model again. Max 3 tool rounds per turn. All tools are read-only —
// D-08 unchanged: no orders, approvals, watches, leases or kill-switch writes.
//
// Tools available:
//   get_prices({symbols: string[]})   -> live venue prices + age (Worker local)
//   query_state({domain})             -> platform snapshot slice (D1)
//   list_drafts({})                   -> recent strategy drafts (D1)
//   list_strategies({})               -> active strategy versions (D1)
//
// Fail-soft: a tool outage returns {ok:false, error} — the model must say so,
// never invent numbers.

/** Max tool rounds per turn — prevents infinite loops and bounds latency. */
export const MAX_TOOL_ROUNDS = 3;

/** Marker the model must prefix a tool call with. */
export const TOOL_MARKER = "TOOL:";

/** Shape every tool returns. */
export function toolResult(ok, data, { error, ageMs } = {}) {
  return { ok, data, error, ageMs };
}

/** Execute one tool by name. Returns {ok, data, error, ageMs}. */
export async function runTool(env, name, args, opts = {}) {
  const start = Date.now();
  try {
    switch (name) {
      case "get_prices": {
        const { listPrices } = await import("./quotes.mjs");
        const { sharedWindow } = await import("./fallback-poll.mjs");
        const symbols = Array.isArray(args?.symbols) ? args.symbols.filter((s) => typeof s === "string") : [];
        if (!symbols.length) return toolResult(false, null, { error: "symbols required" });
        const p = await listPrices(env, {
          url: new URL(`https://x?symbols=${symbols.join(",")}`),
          window: sharedWindow,
        });
        return toolResult(true, { mode: p.mode, prices: p.prices ?? {}, missing: p.missing ?? [], at: p.at }, { ageMs: Date.now() - start });
      }
      case "query_state": {
        const { collectSnapshot } = await import("./platform-snapshot.mjs");
        const domain = String(args?.domain ?? "").trim();
        const s = await collectSnapshot(env);
        const slice = {
          mode: s.modeRows?.[0],
          watches: s.watches,
          signals: s.signals,
          approvals: s.approvals,
          intents: s.intents,
          orders: s.orders,
          positions: s.positions,
          incidents: s.incidents,
        }[domain];
        return toolResult(true, { domain, data: slice ?? null, available: !!slice }, { ageMs: Date.now() - start });
      }
      case "list_drafts": {
        if (!env?.DB?.prepare) return toolResult(true, { drafts: [] }, { ageMs: Date.now() - start });
        const rows = await env.DB.prepare(
          "SELECT id, strategy_id, version, status, model, created_at FROM strategy_drafts WHERE status <> 'deleted' ORDER BY created_at DESC LIMIT 10"
        ).all().catch(() => ({ results: [] }));
        return toolResult(true, { drafts: rows.results ?? [] }, { ageMs: Date.now() - start });
      }
      case "list_strategies": {
        if (!env?.DB?.prepare) return toolResult(true, { strategies: [] }, { ageMs: Date.now() - start });
        const rows = await env.DB.prepare(
          "SELECT version, config_json, activated_by, at FROM strategy_configs ORDER BY at DESC LIMIT 10"
        ).all().catch(() => ({ results: [] }));
        return toolResult(true, { strategies: rows.results ?? [] }, { ageMs: Date.now() - start });
      }
      default:
        return toolResult(false, null, { error: `unknown tool ${name}` });
    }
  } catch (e) {
    return toolResult(false, null, { error: e?.message ?? String(e), ageMs: Date.now() - start });
  }
}

/** Parse a single TOOL: line from model text. Returns {name, args} or null. */
export function parseToolCall(text) {
  if (typeof text !== "string") return null;
  const lines = String(text).split("\n");
  for (const line of lines) {
    // Tolerate a bullet/indent the model may add ("- TOOL: ..."), but never
    // match a sentence that merely mentions the marker mid-line.
    const m = line.match(/^\s*(?:[-*]\s*)?TOOL:\s*(\w+)\s*(\{[\s\S]*\})?\s*$/);
    if (!m) continue;
    let args = {};
    if (m[2]) {
      try { args = JSON.parse(m[2]); } catch { return null; } // malformed JSON -> skip
    }
    return { name: m[1], args };
  }
  return null;
}

/** stripToolLines removes TOOL: lines from text so a caller never shows raw tool syntax. */
export function stripToolLines(text) {
  if (typeof text !== "string") return "";
  return text
    .split("\n")
    .filter((l) => !/^\s*(?:[-*]\s*)?TOOL:\s*\w+/.test(l))
    .join("\n")
    .trim();
}

/** System message that tells the model which tools exist and how to call them. */
export function toolSystemPrompt() {
  return `TOOLS AVAILABLE (read-only, advisory — call at most once per need, max ${MAX_TOOL_ROUNDS} rounds):
- get_prices({symbols: string[]}) -> live venue prices with age; use for "what is BTCUSDT at?"
- query_state({domain:"mode|watches|signals|approvals|intents|orders|positions|incidents"}) -> platform snapshot slice
- list_drafts({}) -> recent strategy drafts (review-only, never deployed)
- list_strategies({}) -> active strategy versions with config
Emit exactly one line: TOOL: <name> <json>
Never invent prices or state — if a tool returns unavailable/error, say so. Do not call tools for general knowledge; use them only for live platform data.`;
}
