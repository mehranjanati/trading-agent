# ADR-010 — Multimodal Chart Chat (vision turns, R2/D1 media, turn ids)

Status: PROPOSED 2026-10-14 | Relates: docs 04,10,18, ADR-002/005 | Deciders: human + architect

## Context
Traders author strategies from a chart screenshot: "code this setup". Until now the
chat plane was text-only, so the user had to describe a chart in prose. Three live
probes on the deployed Worker (`@cf/qwen/qwen3.8-27b`) settled the mechanics:

1. Workers AI accepts an image **only** as an OpenAI content part
   (`{type:"image_url", image_url:{url:"data:image/png;base64,...", detail}}`) on the
   `user` role. The top-level `image` parameter is deprecated and ignored.
2. `/no_think` appended to **array** content string-coerces it to `"[object Object]"`.
   The model then answers about that literal string, not the chart. The directive must
   land on the text part.
3. Qwen3 needs **both** `reasoning_effort:"low"` and
   `chat_template_kwargs:{enable_thinking:false}` to stop emitting chain-of-thought;
   either alone still fills `reasoning` and leaves `content` null.

Cost was measured, not estimated: a 1600x900 chart is **1432 prompt tokens** at
`detail:"low"` (~$0.0006 in) and the count scales with resolution.

D1 caps a string/BLOB/row at **2,000,000 bytes**, so a base64 chart can never be a
column value.

## Decision
- **Wire.** The dashboard downscales client-side to a 1568px longest edge, JPEG q0.85,
  and sends `{type:"message", id, content, images:[{mediaType,dataUrl,detail}], image}` over
  the existing chat WebSocket — a turn carries up to `maxImagesPerTurn` (4) charts, one
  `image_url` part each; the legacy singular `image` still carries the first chart so an
  older server analyzes at least one. Go validates every entry against the media-type
  allow-list (png/jpeg/webp), the dataUrl↔mediaType match and the size cap, and raises the
  WS read limit 64 KiB → 10 MiB for a multi-chart frame.
- **Model routing.** A turn carrying an image part routes to `AI_VISION_MODEL`
  (`@cf/qwen/qwen3.8-27b`); text-only turns stay on the cheap `AI_MODEL`. The Worker
  reports the choice on `x-ai-model` / `x-ai-vision`.
- **Storage.** Bytes go to the R2 bucket (`CHAT_MEDIA`, key
  `chat/{session}/{messageId}/{imgId}`); D1 keeps only a `chat_attachments` metadata row
  (`message_id`, `session_id`, `media_type`, `bytes`, `r2_key`, `sha256`, `created_at`).
  Persistence is fail-soft: chat is advisory, so a storage outage never silences the answer.
- **Turn ids.** The client mints `crypto.randomUUID()` per turn; Go echoes it on
  `done.messageId`, and `strategy_drafts.message_id` records it, so a saved draft is
  traceable to the exact chart that produced it.
- **Cost bound.** Only the newest `maxImageTurns` (2) image-bearing turns carry their
  bytes to the model; older charts degrade to a `[chart image attached earlier]` marker.
  `ApplyWindow` charges ~1500 tokens per attachment so the window cannot overflow.

## Alternatives
- A: Store base64 in D1 — impossible (2 MB cap) and would bloat every read.
- B: Client uploads straight to R2 via a presigned URL — rejected: adds a second auth
  surface and an out-of-band upload the Worker cannot attribute to a session.
- C: Re-send every chart on every turn — rejected: one chart ≈1400 tokens, so a 10-turn
  session would pay ~14k prompt tokens for images alone.
- D: Keep the deprecated top-level `image` param — rejected: ignored by the model.

## Consequences
- The Redis session value grows by the inline data URL of each chart turn (bounded by
  the 2 MB WS cap). Acceptable for a 24h session; a follow-up can store only the R2 key
  and re-fetch within the 2-turn window.
- Charts live in R2, so the R2 binding must exist per environment before deploying; a
  missing binding degrades to metadata-less chat rather than failing the turn.
- Vision turns are ~4x the input cost of a text turn; the UI shows the downscaled size
  so the trade is visible.

## Verification
`workers/src/chat-vision.test.mjs` (allow-list, size cap, `/no_think` on the text part,
both reasoning switches, R2+D1 split) and the chart-image cases in
`workers/src/strategies-ai.test.mjs` (vision routing, headers, persistence, draft
`message_id`). Go: `go-watcher/chat/vision_test.go` (boundary validation, multimodal
assembly, 2-turn byte window, window budget). `make check` green.
