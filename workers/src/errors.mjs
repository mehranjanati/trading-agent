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
// against this API on a different origin (workers.dev). CORS deliberately
// allows browser READS only (GET/HEAD) — POST is excluded from allow-methods so
// a cross-origin browser can never submit orders/approvals (D-08, read-only
// BFF). Non-browser callers (Go watcher, drills) are unaffected by CORS.
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "accept, content-type, x-role, x-agent-token",
  "access-control-max-age": "86400",
};
export function ok(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}
