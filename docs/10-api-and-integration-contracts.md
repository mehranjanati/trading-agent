# 10 — API & Integration Contracts

## Internal REST (v1, auth: Bearer, Idempotency-Key where mutating)
- `POST /api/watches {symbol,trigger,invalidation,expires_at}` → 201 `{id}`. Errors: 400 validation, 409 dedupe, 429 rate.
- `POST /api/signals:ingest`, `POST /api/analysis:runs`, `POST /api/approvals {decision}`, `POST /api/orders:intents` (requires approval_id + risk pass), `GET /api/health`, `GET /api/recovery/log`.
- Error envelope `{code,message,trace_id,retryable}`. Versioning: `/v1`, additive only.

## Events (examples)
- `watch.triggered_v1 {watch_id,symbol,px,ts,evt_id}`. `approval.granted_v1 {approval_id,watch_id,expires_at}`. `order.intent_v1 {intent_id,client_order_id,...}`.

## Exchange boundary
- Public WS: subscribe `futures.ticker.{SYM}` (VERIFY_REQUIRED: exact channel + limits; record URL/date). REST signed HMAC, recvWindow 5000; rate budget documented in ADR-004; never exceed.
