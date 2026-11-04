// chat-store.test.mjs — ADR-014: the durable chat log. Pure helpers are tested
// directly (session ids, validation, attachment metadata, row mapping) and one
// flow test runs append → history against a small in-memory D1 fake, so the
// "chat disappears" regression has a machine-checkable guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sessionIdForSymbol,
  symbolFromSession,
  attachmentMeta,
  normalizeTurn,
  parseAttachments,
  rowsToMessages,
  appendTurn,
  history,
  deleteSession,
  MAX_CONTENT,
  MAX_ATTACHMENTS,
} from "./chat-store.mjs";

test("sessionIdForSymbol: one permanent thread per venue symbol", () => {
  assert.equal(sessionIdForSymbol("openusdt"), "sym_OPENUSDT");
  assert.equal(sessionIdForSymbol(" OPENUSDT "), "sym_OPENUSDT");
  assert.equal(sessionIdForSymbol("BTCUSDT"), "sym_BTCUSDT");
  // Fail closed: a typo/shape mismatch must never mint a second thread.
  assert.equal(sessionIdForSymbol("btc-usdt"), "");
  assert.equal(sessionIdForSymbol("BTC"), "");
  assert.equal(sessionIdForSymbol(""), "");
  assert.equal(sessionIdForSymbol(null), "");
  // Round trip: the id carries the symbol back for the D1 column.
  assert.equal(symbolFromSession("sym_OPENUSDT"), "OPENUSDT");
  assert.equal(symbolFromSession("chat_1700000000_abc123"), "");
});

test("attachmentMeta: bytes stay in R2, only metadata reaches D1", () => {
  const meta = attachmentMeta([
    { mediaType: "image/jpeg", detail: "low", bytes: 1234, dataUrl: "data:image/jpeg;base64,AAAA" },
    { mediaType: "", dataUrl: "x" }, // no type → dropped
    null,
  ]);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].dataUrl, undefined);
  assert.equal(meta[0].mediaType, "image/jpeg");
  const many = attachmentMeta(Array.from({ length: 9 }, () => ({ mediaType: "image/png" })));
  assert.equal(many.length, MAX_ATTACHMENTS);
  assert.deepEqual(attachmentMeta(null), []);
});

test("normalizeTurn: validates role/session and caps content", () => {
  const now = Date.parse("2026-11-04T10:00:00.000Z");
  const row = normalizeTurn({ session_id: "sym_OPENUSDT", role: "user", content: "hi" }, now);
  assert.equal(row.session_id, "sym_OPENUSDT");
  assert.equal(row.role, "user");
  assert.equal(row.at, "2026-11-04T10:00:00.000Z");
  assert.match(row.id, /^cmsg_/);
  assert.equal(row.attachments_json, "[]");
  assert.throws(() => normalizeTurn({ session_id: "", role: "user", content: "" }), /session_id/);
  assert.throws(() => normalizeTurn({ session_id: "s", role: "system", content: "" }), /role/);
  assert.throws(() => normalizeTurn({ session_id: "s", role: "user", content: "x".repeat(MAX_CONTENT + 1) }), /content/);
});

test("parseAttachments / rowsToMessages: tolerant reads in the wire shape", () => {
  assert.deepEqual(parseAttachments('{"nope":1}'), []);
  assert.deepEqual(parseAttachments("not-json"), []);
  assert.deepEqual(parseAttachments('[{"mediaType":"image/png"}]'), [{ mediaType: "image/png" }]);
  const msgs = rowsToMessages([
    { id: "m1", role: "user", content: "hi", attachments_json: "[]", message_id: "turn-1", at: "2026-11-04T10:00:00.000Z" },
  ]);
  assert.deepEqual(msgs, [
    { id: "m1", role: "user", content: "hi", attachments: [], timestamp: "2026-11-04T10:00:00.000Z", message_id: "turn-1" },
  ]);
});

/** In-memory D1 fake: only the four statements this module issues. */
function fakeEnv() {
  const sessions = new Map();
  const messages = [];
  const prepare = (sql) => ({
    _sql: sql.trim(),
    _a: [],
    bind(...a) {
      this._a = a;
      return this;
    },
    async run() {
      const s = this._sql;
      if (s.startsWith("INSERT INTO chat_sessions")) {
        const [id, symbol, principles, created_at, updated_at] = this._a;
        const cur = sessions.get(id);
        sessions.set(id, {
          id,
          symbol: symbol || cur?.symbol || "",
          principles: principles || cur?.principles || "",
          created_at: cur?.created_at ?? created_at,
          updated_at,
        });
        return { meta: { changes: 1 } };
      }
      if (s.startsWith("INSERT INTO chat_messages")) {
        const [id, session_id, role, content, attachments_json, message_id, at] = this._a;
        messages.push({ id, session_id, role, content, attachments_json, message_id, at });
        return { meta: { changes: 1 } };
      }
      if (s.startsWith("DELETE FROM chat_messages")) {
        let n = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].session_id === this._a[0]) {
            messages.splice(i, 1);
            n++;
          }
        }
        return { meta: { changes: n } };
      }
      if (s.startsWith("DELETE FROM chat_sessions")) {
        sessions.delete(this._a[0]);
        return { meta: { changes: 1 } };
      }
      throw new Error("unexpected run SQL: " + s);
    },
    async all() {
      const s = this._sql;
      if (s.startsWith("SELECT id,symbol,principles")) {
        const r = sessions.get(this._a[0]);
        return { results: r ? [r] : [] };
      }
      if (s.startsWith("SELECT id,session_id,role")) {
        const [id, limit] = this._a;
        const rows = messages
          .filter((m) => m.session_id === id)
          .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
          .slice(0, limit);
        return { results: rows };
      }
      throw new Error("unexpected all SQL: " + s);
    },
  });
  return { DB: { prepare } };
}

test("appendTurn → history → deleteSession: the transcript survives (regression)", async () => {
  const env = fakeEnv();
  const now = Date.parse("2026-11-04T10:00:00.000Z");
  await appendTurn(env, { session_id: "sym_OPENUSDT", role: "user", content: "سلام", message_id: "t1" }, now);
  await appendTurn(
    env,
    { session_id: "sym_OPENUSDT", role: "assistant", content: "bias LONG", attachments: [{ mediaType: "image/png", bytes: 12, dataUrl: "data:image/png;base64,AA" }] },
    now + 1000,
  );

  const h = await history(env, "sym_OPENUSDT");
  assert.equal(h.symbol, "OPENUSDT"); // derived from the session id
  assert.deepEqual(h.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(h.messages[0].content, "سلام");
  assert.equal(h.messages[1].attachments.length, 1);
  assert.equal(h.messages[1].attachments[0].dataUrl, undefined); // bytes never in D1

  // A different symbol is a different thread.
  assert.equal((await history(env, "sym_ETHUSDT")).messages.length, 0);
  // Limit applies.
  assert.equal((await history(env, "sym_OPENUSDT", 1)).messages.length, 1);

  const del = await deleteSession(env, "sym_OPENUSDT");
  assert.equal(del.deleted, 2);
  assert.equal((await history(env, "sym_OPENUSDT")).messages.length, 0);
  await assert.rejects(() => history(env, ""), /session/);
});
