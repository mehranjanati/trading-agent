// notify.mjs — Telegram alerting for the AI-operator loop (fail-open, never fatal).
//
// Design: the trading path NEVER calls Telegram synchronously. Routes only
// ENQUEUE rows into `notification_outbox`; the cron drains them later. A
// Telegram outage, a missing token, or a send failure therefore degrades to
// "no push" — the trade flow is unaffected (SAFE-001: alerting is advisory).
//
// Setup (operator):
//   wrangler secret put TELEGRAM_BOT_TOKEN   # from @BotFather (never in git)
//   TELEGRAM_CHAT_ID var or secret           # numeric chat/group id (@userinfobot)
//
// Quiet topics (user-selectable, 5m/15m scalping): TRIGGERED / INVALIDATED /
// ANALYSIS_READY / APPROVAL_REQUESTED / ORDER_UPDATE / SAFETY / POSITION_DIGEST.
// Preferences live in `notify_prefs(topic PK, enabled)`; seed enables all, and
// the user toggles topics via POST /api/notify:prefs (trader+).
export const TOPICS = [
  "TRIGGERED",
  "INVALIDATED",
  "ANALYSIS_READY",
  "APPROVAL_REQUESTED",
  "ORDER_UPDATE",
  "SAFETY",
  "POSITION_DIGEST",
];

export function isTopic(t) {
  return TOPICS.includes(t);
}

/** Escape Telegram HTML parse-mode specials. */
export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Persian-first message formatter (numbers stay Latin). One topic -> one text. */
export function formatAlert({ topic, symbol, direction, px, extra = {} }) {
  const sym = esc(symbol ?? "?");
  const dir = direction === "LONG" ? "لانگ" : direction === "SHORT" ? "شورت" : esc(direction ?? "");
  switch (topic) {
    case "TRIGGERED":
      return `⏰ <b>تریگر شد</b>\n${sym} ${dir}\nقیمت: <code>${esc(px)}</code>`;
    case "INVALIDATED":
      return `🚫 <b>ابطال شد</b>\n${sym} ${dir}\nقیمت: <code>${esc(px)}</code>`;
    case "ANALYSIS_READY": {
      const bias = extra.bias ?? "?";
      const conf = extra.confidence ?? "?";
      const verdict = extra.verdict ? `\nنتیجه AI: <b>${esc(extra.verdict)}</b>` : "";
      return `📊 <b>تحلیل آماده شد</b>\n${sym} ${dir}\nبایاس: <b>${esc(bias)}</b> (اطمینان ${esc(conf)})${verdict}`;
    }
    case "APPROVAL_REQUESTED":
      return `✋ <b>تأیید لازم است</b>\n${sym} ${dir}\n${extra.summary ? `${esc(extra.summary)}\n` : ""}⏳ انقضا: ${esc(extra.expires_in ?? "10 دقیقه")}`;
    case "ORDER_UPDATE": {
      const st = esc(extra.status ?? "?");
      return `🧾 <b>سفارش: ${st}</b>\n${sym} ${dir}\nمقدار: <code>${esc(extra.qty ?? "?")}</code>${extra.note ? `\n${esc(extra.note)}` : ""}`;
    }
    case "SAFETY":
      return `🛑 <b>هشدار ایمنی</b>\n${esc(extra.title ?? "رویداد ایمنی")}${extra.detail ? `\n${esc(extra.detail)}` : ""}`;
    case "POSITION_DIGEST":
      return `📌 <b>خلاصه پوزیشن‌ها</b>\n${esc(extra.body ?? "پوزیشنی باز نیست")}`;
    default:
      return `🔔 ${esc(topic)}\n${sym}`;
  }
}

/** Resolve Telegram config from env. Returns {ok, token, chatId, reason}. */
export function telegramConfig(env) {
  const token = env?.TELEGRAM_BOT_TOKEN ?? null;
  const chatId = env?.TELEGRAM_CHAT_ID ?? null;
  if (!token) return { ok: false, token: null, chatId: null, reason: "TELEGRAM_BOT_TOKEN not set" };
  if (!chatId) return { ok: false, token: null, chatId: null, reason: "TELEGRAM_CHAT_ID not set" };
  return { ok: true, token, chatId: String(chatId) };
}

/** Enqueue one alert. Idempotent per dedupe_key (UNIQUE) - retries never double-send. */
export async function enqueueAlert(env, { topic, symbol, payload = {}, dedupeKey }) {
  if (!isTopic(topic)) {
    const e = new Error(`unknown notify topic ${topic}`);
    e.code = "VALIDATION";
    throw e;
  }
  const id = `ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO notification_outbox(id,topic,symbol,payload_json,dedupe_key,attempts,sent_at,at) VALUES(?,?,?,?,?,?,NULL,?) " +
      "ON CONFLICT(dedupe_key) DO NOTHING",
  ).bind(id, topic, symbol ?? null, JSON.stringify(payload), dedupeKey ?? `${topic}:${symbol ?? "?"}:${at}`, 0, at).run();
  return { id };
}

/** Read the user preference for a topic (default: enabled). */
export async function topicEnabled(env, topic) {
  const row = await env.DB.prepare("SELECT enabled FROM notify_prefs WHERE topic=?").bind(topic).all()
    .catch(() => ({ results: [] }));
  const r = row.results?.[0];
  if (!r) return true;
  return Number(r.enabled) !== 0;
}

/** Send one message via Bot API. Throws on transport or Telegram error. */
export async function sendTelegram({ token, chatId, text, fetchFn = fetch }) {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok || body?.ok === false) {
    throw new Error(`telegram HTTP ${res.status}: ${body?.description ?? "send failed"}`);
  }
  return { message_id: body?.result?.message_id ?? null };
}

export const DRAIN_LIMIT = 20;
export const MAX_ATTEMPTS = 5;

/** Drain due outbox rows: format -> topic gate -> send -> mark sent. Returns counts. */
export async function drainNotifications(env, { nowMs = Date.now(), fetchFn = fetch, limit = DRAIN_LIMIT } = {}) {
  const cfg = telegramConfig(env);
  const rows = await env.DB.prepare(
    "SELECT id,topic,symbol,payload_json,dedupe_key,attempts FROM notification_outbox WHERE sent_at IS NULL AND attempts < ? ORDER BY at LIMIT ?",
  ).bind(MAX_ATTEMPTS, limit).all().catch(() => ({ results: [] }));
  let sent = 0, skipped = 0, deferred = 0;
  for (const r of rows.results ?? []) {
    let payload = {};
    try { payload = JSON.parse(r.payload_json ?? "{}"); } catch { payload = {}; }
    if (!(await topicEnabled(env, r.topic))) {
      await markSent(env, r.id, nowMs);
      skipped++;
      continue;
    }
    if (!cfg.ok) {
      await deferRow(env, r.id, r.attempts);
      deferred++;
      continue;
    }
    const text = formatAlert({ topic: r.topic, symbol: r.symbol, ...payload });
    try {
      await sendTelegram({ token: cfg.token, chatId: cfg.chatId, text, fetchFn });
      await markSent(env, r.id, nowMs);
      sent++;
    } catch {
      await deferRow(env, r.id, r.attempts);
      deferred++;
    }
  }
  return { sent, skipped, deferred, unconfigured: !cfg.ok, reason: cfg.reason ?? null };
}

async function markSent(env, id, nowMs) {
  await env.DB.prepare("UPDATE notification_outbox SET sent_at=?, attempts=attempts+1 WHERE id=?")
    .bind(new Date(nowMs).toISOString(), id).run().catch(() => {});
}

async function deferRow(env, id, attempts) {
  await env.DB.prepare("UPDATE notification_outbox SET attempts=? WHERE id=?").bind((attempts ?? 0) + 1, id).run().catch(() => {});
}
