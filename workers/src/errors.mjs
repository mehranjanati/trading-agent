// errors.mjs — E05-T01-S3: error envelope {code,message,trace_id,retryable}.
// Codes per docs/10 §10.1. trace_id = evt/intent ID when available, else random.
import { randomUUID } from "node:crypto";
export const Codes = {
  VALIDATION: 400, AUTH: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  APPROVAL_EXPIRED: 410, RISK_REJECT: 422, RATE: 429, NOT_IMPLEMENTED: 501, DEGRADED: 503,
};
export function err(code, message, opts = {}) {
  const status = Codes[code] ?? 500;
  return Response.json(
    {
      code, message,
      trace_id: opts.trace || randomUUID(),
      retryable: opts.retryable ?? (status === 429 || status === 503),
      ...(opts.extra ?? {}),
    },
    { status, headers: CORS },
  );
}
// E12-T01: the Pages dashboard (*.pages.dev) refreshes client-side (onMount)
// against this API on a different origin (workers.dev).
// D-08 is enforced at the CORS layer: POST is allowed ONLY for advisory /
// operator reads-writes (chat, generate, draft, watches); the order/approval
// paths (orders:intents, approvals, kill-switch, strategy:activate,
// lease:handoff) are NOT in the allow-list, so a cross-origin browser can
// never submit orders/approvals. Same-origin callers and non-browser clients
// (Go watcher, drills) are unaffected by CORS.
// BROWSER_POST_PATHS enumerates the only paths a browser may POST to.
export const BROWSER_POST_PATHS = new Set([
  "/api/strategy:generate",
  "/api/strategy:chat",
  "/api/strategy:chat:stream",
  "/api/strategy:draft",
  // Discarding a review-only draft is advisory-only (nothing executes from a
  // draft), so the dashboard may POST it — same class as the save route above.
  "/api/strategy:draft:delete",
  "/api/watches",
]);
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "accept, content-type, x-role, x-agent-token",
  "access-control-max-age": "86400",
};
// corsFor returns the CORS headers for a request: POST (and preflights that
// ask for POST) get access-control-allow-methods: POST only on whitelisted
// paths (fail closed everywhere else — notably /api/orders:intents and
// /api/approvals).
export function corsFor(req) {
  if (req) {
    try {
      const p = new URL(req.url).pathname;
      if (!BROWSER_POST_PATHS.has(p)) return CORS;
      // Direct POST.
      if (req.method === "POST") {
        return { ...CORS, "access-control-allow-methods": "GET, HEAD, OPTIONS, POST" };
      }
      // CORS preflight asking for POST.
      if (req.method === "OPTIONS") {
        const want = req.headers?.get?.("access-control-request-method");
        if (typeof want === "string" && want.toUpperCase() === "POST") {
          return { ...CORS, "access-control-allow-methods": "GET, HEAD, OPTIONS, POST" };
        }
      }
    } catch { /* fall through to the base allow-list */ }
  }
  return CORS;
}
export function ok(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}
