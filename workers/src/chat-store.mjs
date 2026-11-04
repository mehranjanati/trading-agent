// chat-store.mjs — ADR-014: the DURABLE chat log (D1), the canonical record of
// every advisory transcript turn.
//
// WHY IT EXISTS: the chat plane stored messages only in Redis (`chat:{id}:msgs`)
// with a 24h TTL, and the session id lived only in the browser's
// localStorage. A day of inactivity, a Redis restart, another device or a
// cleared storage wiped the conversation — the exact bug this module fixes.
// D1 is now the source of truth; Redis stays a hot cache and R2 keeps the chart
// BYTES (chat_attachments, ADR-010), because D1 caps a row at 2,000,000 bytes.
//
// SESSION MODEL (chosen 2026-11-04): ONE PERMANENT THREAD PER SYMBOL,
// `session_id = "sym_<SYMBOL>"` (e.g. sym_OPENUSDT). The legacy floating widget
// keeps its random id with symbol ''. The partial UNIQUE index on
// chat_sessions(symbol) makes a second thread for the same symbol impossible.
//
// Everything here is advisory data: no watch, order, approval or kill-switch
// authority is reachable from this module (D-08).
import { uid } from "./_shared.mjs";

/** MAX_CONTENT bounds one stored message (D1 row cap is 2 MB; a transcript turn
 *  is text only — charts ride R2 — so 32k chars is generous and safe). */
export const MAX_CONTENT = 32_000;
/** MAX_ATTACHMENTS mirrors the per-turn chart cap (maxImagesPerTurn = 4). */
export const MAX_ATTACHMENTS = 4;
/** MAX_HISTORY bounds one read so a huge thread cannot blow a response. */
export const MAX_HISTORY = 500;

const SYM_RE = /^[A-Z]{2,12}USDT$/;

/** sessionIdForSymbol — the deterministic thread id for one venue symbol, or
 *  "" when the symbol is not a valid `*-USDT` name (fail closed: a typo must
 *  never mint a second thread). */
export function sessionIdForSymbol(symbol) {
  const s = String(symbol ?? "").trim().toUpperCase();
  return SYM_RE.test(s) ? `sym_${s}` : "";
}

/** symbolFromSession — inverse of sessionIdForSymbol, so a caller that only has
 *  the session id (the Go service posts just {session_id}) still records which
 *  symbol the thread belongs to. "" when the id is not a symbol thread. */
export function symbolFromSession(session_id) {
  const m = /^sym_([A-Z]{2,12}USDT)$/.exec(String(session_id ?? "").trim().toUpperCase());
  return m ? m[1] : "";
}

/** attachmentMeta — keep only metadata; a data URL must never reach D1. */
export function attachmentMeta(attachments) {
  const list = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
  return list
    .map((a) => ({
      mediaType: typeof a?.mediaType === "string" ? a.mediaType : "",
      detail: typeof a?.detail === "string" ? a.detail : undefined,
      bytes: Number.isFinite(a?.bytes) ? Number(a.bytes) : undefined,
    }))
    .filter((a) => a.mediaType);
}

/** normalizeTurn — validate one transcript turn into the row shape. Throws
 *  `{code:"VALIDATION"}` on anything a transcript cannot contain, so a bad
 *  append is a 422 instead of a corrupt row. */
export function normalizeTurn(input, nowMs = Date.now()) {
  const session_id = String(input?.session_id ?? "").trim();
  if (!session_id) {
    const e = new Error("session_id is required");
    e.code = "VALIDATION";
    throw e;
  }
  const role = String(input?.role ?? "").trim();
  if (role !== "user" && role !== "assistant") {
    const e = new Error("role must be user|assistant");
    e.code = "VALIDATION";
    throw e;
  }
  const content = String(input?.content ?? "");
  if (content.length > MAX_CONTENT) {
    const e = new Error(`content exceeds ${MAX_CONTENT} chars`);
    e.code = "VALIDATION";
    throw e;
  }
  const at = typeof input?.at === "string" && input.at ? input.at : new Date(nowMs).toISOString();
  return {
    id: uid("cmsg"),
    session_id,
    role,
    content,
    attachments_json: JSON.stringify(attachmentMeta(input?.attachments)),
    message_id: typeof input?.message_id === "string" ? input.message_id : null,
    at,
  };
}

/** ensureSession — idempotent create/touch of a session row. A non-empty
 *  `symbol` or `principles` on a later call fills the blank column instead of
 *  overwriting what is there (the transcript is append-only history). */
export async function ensureSession(env, { session_id, symbol = "", principles = "", nowMs = Date.now() }) {
  const at = new Date(nowMs).toISOString();
  await env.DB.prepare(
    "INSERT INTO chat_sessions(id,symbol,principles,created_at,updated_at) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, " +
      "symbol=CASE WHEN excluded.symbol<>'' THEN excluded.symbol ELSE chat_sessions.symbol END, " +
      "principles=CASE WHEN excluded.principles<>'' THEN excluded.principles ELSE chat_sessions.principles END",
  )
    .bind(session_id, symbol, principles, at, at)
    .run();
  return { id: session_id, symbol, at };
}

/** appendTurn — persist ONE message. The caller (Worker REST path or the Go
 *  service through POST /api/chat:append) has already answered the user; this
 *  is fail-soft by contract, so the route reports an error and the turn stands. */
export async function appendTurn(env, input, nowMs = Date.now()) {
  const row = normalizeTurn(input, nowMs);
  const explicit = sessionIdForSymbol(input?.symbol ?? "");
  const derived = symbolFromSession(row.session_id);
  await ensureSession(env, {
    session_id: row.session_id,
    // The explicit body symbol wins (the browser knows it); otherwise the id
    // itself says which venue symbol the thread belongs to.
    symbol: explicit ? String(input.symbol).trim().toUpperCase() : derived,
    principles: typeof input?.principles === "string" ? input.principles : "",
    nowMs,
  });
  await env.DB.prepare(
    "INSERT INTO chat_messages(id,session_id,role,content,attachments_json,message_id,at) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(row.id, row.session_id, row.role, row.content, row.attachments_json, row.message_id, row.at)
    .run();
  return row.id;
}

/** parseAttachments — tolerant JSON read: a corrupt column renders as no
 *  attachments instead of failing the whole transcript. */
export function parseAttachments(json) {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** rowsToMessages — DB rows → the wire shape the Go chat service and the
 *  dashboard already use (`{id, role, content, attachments, timestamp}`). */
export function rowsToMessages(rows) {
  return (rows ?? []).map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    attachments: parseAttachments(r.attachments_json),
    timestamp: r.at,
    message_id: r.message_id ?? undefined,
  }));
}

/** history — the session's transcript (oldest first) plus its metadata. A
 *  missing session is an empty transcript, never an error: the caller may be
 *  opening a symbol's thread for the first time. */
export async function history(env, session_id, limit = MAX_HISTORY) {
  const id = String(session_id ?? "").trim();
  if (!id) {
    const e = new Error("session is required");
    e.code = "VALIDATION";
    throw e;
  }
  const n = Math.min(Math.max(Number(limit) || MAX_HISTORY, 1), MAX_HISTORY);
  const sess = (await env.DB.prepare("SELECT id,symbol,principles,created_at,updated_at FROM chat_sessions WHERE id=?").bind(id).all()).results ?? [];
  const rows = (
    await env.DB.prepare(
      "SELECT id,session_id,role,content,attachments_json,message_id,at FROM chat_messages WHERE session_id=? ORDER BY at, id LIMIT ?",
    )
      .bind(id, n)
      .all()
  ).results ?? [];
  const s = sess[0] ?? null;
  return {
    session_id: id,
    symbol: s?.symbol ?? "",
    principles: s?.principles ?? "",
    messages: rowsToMessages(rows),
  };
}

/** deleteSession — hard delete (an explicit "clear this thread"). Attachments
 *  stay in R2/chat_attachments for audit; only the transcript goes. */
export async function deleteSession(env, session_id) {
  const id = String(session_id ?? "").trim();
  if (!id) return { deleted: 0 };
  const res = await env.DB.prepare("DELETE FROM chat_messages WHERE session_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM chat_sessions WHERE id=?").bind(id).run();
  return { deleted: Number(res?.meta?.changes ?? 0) };
}
