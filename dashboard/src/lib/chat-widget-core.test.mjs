// chat-widget-core.test.mjs — pure helpers for the floating chat widget.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WIDGET_SESSION_KEY,
  WIDGET_MESSAGES_KEY,
  WIDGET_OPEN_KEY,
  WIDGET_VISIBLE_TURNS,
  visibleMessages,
  applyWsEvent,
  buildOutbound,
  buildRestOutbound,
  parseChatStreamFrame,
  pageContext,
  SETUPS_KEY,
  WIDGET_CONTEXT_MAX,
} from "./chat-widget-core.mjs";

describe("widget session keys", () => {
  it("reuses the legacy GLOBAL session (shared with /chat)", () => {
    assert.equal(WIDGET_SESSION_KEY, "chat_session_id");
    assert.equal(WIDGET_MESSAGES_KEY, "chat_messages");
    assert.equal(WIDGET_OPEN_KEY, "chat_widget_open");
    assert.ok(WIDGET_VISIBLE_TURNS > 0);
  });
});

describe("visibleMessages", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));
  it("passes short histories through", () => {
    assert.deepEqual(visibleMessages(mk(3)), mk(3));
  });
  it("keeps the tail of long histories", () => {
    const got = visibleMessages(mk(50), 10);
    assert.equal(got.length, 10);
    assert.equal(got[0].content, "m40");
  });
  it("tolerates junk", () => {
    assert.deepEqual(visibleMessages(null), []);
    assert.deepEqual(visibleMessages(undefined), []);
  });
});

describe("applyWsEvent", () => {
  it("chunk appends to live", () => {
    const s = applyWsEvent({ live: "he", loading: true }, { type: "chunk", text: "llo" });
    assert.equal(s.live, "hello");
    assert.equal(s.commit, null);
  });
  it("done commits and clears", () => {
    const s = applyWsEvent({ live: "streamed", loading: true }, { type: "done", text: "full" });
    assert.equal(s.commit, "full");
    assert.equal(s.live, "");
    assert.equal(s.loading, false);
  });
  it("done falls back to live when text is absent", () => {
    const s = applyWsEvent({ live: "streamed", loading: true }, { type: "done" });
    assert.equal(s.commit, "streamed");
  });
  it("error surfaces and clears", () => {
    const s = applyWsEvent({ live: "x", loading: true }, { type: "error", error: "boom" });
    assert.equal(s.error, "boom");
    assert.equal(s.live, "");
    assert.equal(s.loading, false);
  });
  it("unknown frames are a no-op", () => {
    const s = applyWsEvent({ live: "x", loading: true }, { type: "principles" });
    assert.equal(s.live, "x");
    assert.equal(s.commit, null);
  });
});

describe("buildOutbound", () => {
  it("plain text turn has no image key", () => {
    const e = buildOutbound({ id: "t1", content: "hi" });
    assert.equal(e.type, "message");
    assert.ok(!("image" in e));
  });
  it("chart turn carries the image envelope", () => {
    const e = buildOutbound({ id: "t1", content: "look", image: { mediaType: "image/png", dataUrl: "data:.." } });
    assert.equal(e.image.detail, "low");
    assert.equal(e.image.mediaType, "image/png");
  });
  it("carries the page/room context only when non-empty", () => {
    assert.ok(!("context" in buildOutbound({ id: "t1", content: "hi", context: "   " })));
    const e = buildOutbound({ id: "t1", content: "hi", context: '{"route":"/chat"}' });
    assert.equal(e.context, '{"route":"/chat"}');
  });
});

describe("pageContext", () => {
  it("declares the route and the setup rooms in compact JSON", () => {
    const setups = {
      CELRUSDT: { strategies: [{ id: "sma-cross", version: "1.0.0" }, "rsi-block@0.2.0"], groups: ["g1"], watches: ["w1"], updatedAt: "2026-10-18T09:00:00Z" },
      BTCUSDT: { strategies: [], groups: [], watches: [], updatedAt: "2026-10-18T08:00:00Z" },
    };
    const ctx = JSON.parse(pageContext({ route: "/symbols/CELRUSDT", setups }));
    assert.equal(ctx.route, "/symbols/CELRUSDT");
    assert.equal(ctx.rooms.length, 2);
    assert.deepEqual(ctx.rooms[0].strategies, ["sma-cross@1.0.0", "rsi-block@0.2.0"]);
    assert.deepEqual(ctx.rooms[0].groups, ["g1"]);
  });
  it("caps rooms and total bytes (never an unbounded prompt)", () => {
    const setups = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`S${i}`, { strategies: [], groups: [], watches: [] }]),
    );
    const ctx = JSON.parse(pageContext({ route: "/", setups }));
    assert.equal(ctx.rooms.length, 12);

    const huge = { X: { strategies: Array.from({ length: 40 }, (_, i) => `s${i}@1`), groups: [], watches: [] } };
    const capped = pageContext({ route: "/", setups: huge, max: 60 });
    assert.ok(capped.length <= 60 + "…(truncated)".length);
    assert.ok(capped.endsWith("…(truncated)"));
    assert.equal(WIDGET_CONTEXT_MAX, 4000);
    assert.equal(SETUPS_KEY, "ta_setups_v1");
  });
  it("tolerates junk storage", () => {
    const ctx = JSON.parse(pageContext({ route: "", setups: null }));
    assert.deepEqual(ctx, { route: "", rooms: [] });
  });
});

describe("buildRestOutbound", () => {
  it("charts only the newest turn", () => {
    const msgs = [
      { id: "a", role: "user", content: "old" },
      { id: "b", role: "user", content: "new" },
      { id: "c", role: "assistant", content: "reply" },
    ];
    const out = buildRestOutbound(msgs, "b", { dataUrl: "data:.." });
    assert.equal(typeof out[0].content, "string");
    assert.ok(Array.isArray(out[1].content));
    assert.equal(out[1].content[1].type, "image_url");
    assert.equal(typeof out[2].content, "string");
  });
});

describe("parseChatStreamFrame (POST /api/strategy:chat:stream — the vision-turn transport)", () => {
  const deltaFrame = (content) =>
    JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "@cf/qwen/qwen3.8-27b", choices: [{ index: 0, delta: { content } }] });

  it("extracts the delta text and the model from an OpenAI-style chunk", () => {
    const f = parseChatStreamFrame(`data: ${deltaFrame("سلام")}`);
    assert.ok(f.ok && !f.done);
    assert.equal(f.text, "سلام");
    assert.equal(f.model, "@cf/qwen/qwen3.8-27b");
  });

  it("prefers the top-level response mirror when a frame carries it", () => {
    // The mirror echoes delta.content verbatim — consuming BOTH would double
    // the text; exactly one source per frame.
    const f = parseChatStreamFrame(`data: ${JSON.stringify({ response: "متن", model: "m", choices: [{ delta: { content: "متن" } }] })}`);
    assert.ok(f.ok);
    assert.equal(f.text, "متن");
    assert.equal(f.model, "m");
  });

  it("reads the mirror-only frames (the final usage frame)", () => {
    const f = parseChatStreamFrame('data: {"response":"پایان","usage":{"total_tokens":1}}');
    assert.ok(f.ok && !f.done);
    assert.equal(f.text, "پایان");
  });

  it("marks the [DONE] sentinel and skips keep-alives/comments", () => {
    assert.equal(parseChatStreamFrame("data: [DONE]").done, true);
    assert.equal(parseChatStreamFrame(": keep-alive").ok, false);
    assert.equal(parseChatStreamFrame("").ok, false);
  });

  it("tolerates a non-JSON payload as raw text", () => {
    const f = parseChatStreamFrame("data: قطعه‌ی خام");
    assert.ok(f.ok);
    assert.equal(f.text, "قطعه‌ی خام");
  });

  it("ignores frames with no consumable text (empty delta, usage-only mirror)", () => {
    assert.equal(parseChatStreamFrame(`data: ${deltaFrame("")}`).text, "");
    assert.equal(parseChatStreamFrame('data: {"response":"","usage":{}}').text, "");
    assert.equal(parseChatStreamFrame('data: {"usage":{}}').ok, false);
  });

  it("is the wire twin of the Go side (chat.go parseSSEFrame) — same decisions", () => {
    // data: prefix required; empty payload is a skip, not an error.
    assert.equal(parseChatStreamFrame("hello world").ok, false);
    assert.equal(parseChatStreamFrame("data:").ok, false);
  });
});
