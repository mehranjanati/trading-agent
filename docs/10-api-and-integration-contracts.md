# 10 — API & Integration Contracts (v1 — additive only)

## 10.1 Conventions
Base `/api/v1` (alias `/api` → v1). Auth: `Authorization: Bearer <jwt>`; mutating calls accept `Idempotency-Key`. Errors: `{code, message, trace_id, retryable}`. Codes: 400 VALIDATION, 401/403 AUTH, 404 NOT_FOUND, 409 CONFLICT/DEDUPE, 410 APPROVAL_EXPIRED, 422 RISK_REJECT (with `risk_code`), 429 RATE, 501 NOT_IMPLEMENTED, 503 DEGRADED.

## 10.2 Endpoints
- `POST /api/watches {symbol, direction, trigger, invalidation, expires_at}` → 201 `{id, version}`. 409 on duplicate open watch (same symbol+trigger hash).
- `GET /api/watches?status=ACTIVE` · `GET /api/watches/active-snapshot` (Go boot; full ACTIVE set + versions).
- `POST /api/signals:ingest {watch_id?, kind, payload, source}` → 201 `{id}`. Kinds: DIVERGENCE_TRIPLE|ORDER_BLOCK|OB_OS|MTF|REGIME.
- `POST /api/analysis:runs {watch_id}` → 201 `{id, bias, confidence}` (advisory).
- `POST /api/approvals {watch_id, analysis_id, decision, reason}` → grant token or reject row.
- `POST /api/orders:intents {approval_id, side, qty, leverage}` → 201 `{intent_id, client_order_id}` or 422 `{risk_code}`.
- `POST /api/kill-switch {engaged, reason}` (operator+) · `GET /api/health` · `GET /api/recovery/log`.

## 10.3 Event payload examples
```json
{"id":"evt_01J9Z...","type":"watch.triggered_v1","v":1,"entity_id":"w_abc","seq":3,"ts":"2026-10-10T12:00:00Z","actor":"go-watcher","dedupe_key":"watch.triggered_v1:w_abc:3","payload":{"symbol":"BTCUSDT","px":"67234.5"}}
{"id":"evt_01J9Z...","type":"approval.granted_v1","v":1,"entity_id":"w_abc","seq":5,"ts":"...","actor":"trader:meh","dedupe_key":"approval.granted_v1:w_abc:5","payload":{"approval_id":"ap_123","expires_at":"..."}}
```

## 10.4 Exchange integration boundary (VERIFY_REQUIRED)
- Public WS: subscribe channel + heartbeat + limits to be recorded in E02-T01 with source URL + access date (ADR-004 inputs).
- Signed REST: HMAC-SHA256, `recvWindow=5000`, `clientOrderId` passthrough, rate budget per key; reconcile uses `GET order?clientOrderId=` (exact path verified in E02-T01).
- Never exceed documented limits; fallback poller enforces token-bucket + jitter.
