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
