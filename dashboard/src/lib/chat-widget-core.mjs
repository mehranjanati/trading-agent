// chat-widget-core.mjs — pure helpers for the floating chat widget.
// Stdlib-only and framework-free (same rule as alerts-core): the widget
// renders what these say, so session keys, truncation and WS parsing are
// testable without a browser.
//
// The widget is a second skin over the EXISTING chat service: it reuses the
// global session (`chat_session_id`) so a conversation started in the floating
// panel continues on /chat and vice versa. It never touches watches, orders,
// approvals or kill-switch state (chat is advisory-only, D-08).

/** localStorage keys for the GLOBAL session (the legacy non-room one). */
export const WIDGET_SESSION_KEY = "chat_session_id";
export const WIDGET_MESSAGES_KEY = "chat_messages";
export const WIDGET_OPEN_KEY = "chat_widget_open";

/** Cap so the floating panel never grows past the viewport. Older turns stay
 *  in the session (Redis / /chat shows them); the widget shows the tail. */
export const WIDGET_VISIBLE_TURNS = 30;

/** Return the last N turns for the floating panel. */
export function visibleMessages(messages, limit = WIDGET_VISIBLE_TURNS) {
  if (!Array.isArray(messages)) return [];
  if (messages.length <= limit) return messages;
  return messages.slice(messages.length - limit);
}

/** Minimal WS-event router shared with the /chat page semantics:
 *  chunk -> append to live, done -> commit assistant turn, error -> surface. */
export function applyWsEvent(state, msg) {
  const next = { live: state.live ?? "", error: null, commit: null, loading: state.loading ?? false };
  if (msg?.type === "chunk") {
    next.live = (state.live ?? "") + (msg.text ?? "");
    return next;
  }
  if (msg?.type === "done") {
    next.commit = msg.text ?? state.live ?? "";
    next.live = "";
    next.loading = false;
    return next;
  }
  if (msg?.type === "error") {
    next.error = msg.error ?? "chat error";
    next.live = "";
    next.loading = false;
    return next;
  }
  return next; // unknown frame: no-op
}

/** Build the WS outbound envelope for a user turn (mirrors /chat).
 *  @param {{id: string, content: string, image?: {mediaType: string, dataUrl: string} | null, context?: string}} turn
 *  @returns {{type: string, id: string, content: string, image?: {mediaType: string, dataUrl: string, detail: string}, context?: string}}
 */
export function buildOutbound({ id, content, image, context }) {
  /** @type {{type: string, id: string, content: string, image?: {mediaType: string, dataUrl: string, detail: string}, context?: string}} */
  const env = { type: "message", id, content };
  if (image) env.image = { mediaType: image.mediaType, dataUrl: image.dataUrl, detail: "low" };
  // The dashboard's page/room block: the Go service injects it as a labelled
  // DATA system turn (capped by maxClientContext). Omitted when empty so a
  // turn with nothing to declare does not grow the prompt.
  if (typeof context === "string" && context.trim() !== "") env.context = context;
  return env;
}

/** Cap for the client-declared page block (Go caps at 4000 bytes; stay under). */
export const WIDGET_CONTEXT_MAX = 4000;

/** The one localStorage key the setup rooms live under (setups.ts). */
export const SETUPS_KEY = "ta_setups_v1";

/**
 * pageContext — the browser-only state the chat service cannot see: the route
 * the trader is on plus the setup rooms (symbol → strategies/groups/watches)
 * kept in localStorage. Compact JSON, deterministically capped.
 *
 * It is DATA about the trader's own selection, never an instruction; the
 * canonical watch/order state stays in D1 and arrives via OPERATOR STATE.
 *
 * @param {{route?: string, setups?: Record<string, any> | null, max?: number}} [opts]
 * @returns {string}
 */
export function pageContext({ route = "", setups = null, max = WIDGET_CONTEXT_MAX } = {}) {
  const rooms = [];
  const entries = setups && typeof setups === "object" ? Object.entries(setups) : [];
  for (const [symbol, s] of entries.slice(0, 12)) {
    if (!s || typeof s !== "object") continue;
    const strategies = /** @type {any[]} */ (Array.isArray(s.strategies) ? s.strategies : []);
    rooms.push({
      symbol,
      strategies: strategies.slice(0, 8).map((x) =>
        typeof x === "string" ? x : `${x?.id ?? "?"}@${x?.version ?? "?"}`,
      ),
      groups: (Array.isArray(s.groups) ? s.groups : []).slice(0, 8),
      watches: (Array.isArray(s.watches) ? s.watches : []).slice(0, 8),
      updated_at: typeof s.updatedAt === "string" ? s.updatedAt : null,
    });
  }
  const text = JSON.stringify({ route, rooms });
  if (text.length <= max) return text;
  return text.slice(0, max) + "…(truncated)";
}

/** Build the REST outbound history (Worker :chat shape): the newest turn
 *  carries the chart as an image_url content part. */
export function buildRestOutbound(messages, turnId, image) {
  return messages.map((m) =>
    m.id === turnId && image
      ? {
          id: m.id,
          role: m.role,
          content: [
            { type: "text", text: m.content },
            { type: "image_url", image_url: { url: image.dataUrl, detail: "low" } },
          ],
        }
      : { id: m.id, role: m.role, content: m.content },
  );
}
