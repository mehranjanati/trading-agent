# 18 — Chat Service & Real-Time Strategy Authoring

> Advisory plane only. The chat service never touches watches, orders,
> approvals, leases or kill-switch state; its only writes are its own Redis
> keys (`chat:*`). D-08 (no order submission from the dashboard) is unchanged:
> the AI path ends in a `strategy_drafts` row with status `generated`.

## 18.1 Shape (v2-vibe pattern, trading-scoped)

| Piece | Where | Role |
|---|---|---|
| Session store | Redis (`ta-redis`) | `chat:{id}:meta` HASH{created_at, principles} + `chat:{id}:msgs` LIST of JSON turns, both 24h TTL, refreshed on write |
| Chat service | routes inside `go-watcher` (:8080) | HTTP for session CRUD, WebSocket for the turn loop — same binary/port as the watcher, no second process |
| AI plane | Worker `POST /api/strategy:chat:stream` | owns the `AI` binding (no keys in Go); passes the model's SSE through untouched, reports the model on `x-ai-model` |
| Client | dashboard `/chat` | WS when the Go chat routes are reachable, Worker REST (`/api/strategy:chat`) otherwise |

## 18.2 Contract

HTTP:

- `POST /api/chat/create {principles?}` -> `201 {id}`
- `GET /api/chat/{id}` -> `200 {messages[], principles}` (empty for unknown/TTL-expired id)
- `DELETE /api/chat/{id}` -> `200 {deleted:true}`
- `POST /api/chat/{id}/principles {content}` -> `200 {saved:true}`

WebSocket `/ws/chat/{id}` — the socket stays open for the next turn:

- client → `{"type":"message","id","content","image?":{"mediaType","dataUrl","detail?"}}`
  where `id` is a client-minted turn id (`crypto.randomUUID()`) and `image` is a
  downscaled base64 data URL (ADR-010).
- client → `{"type":"principles","content"}`
- server → `{"type":"chunk","text"}`* then
  `{"type":"done","text","codeBlocks","model","messageId"}`, or `{"type":"error","error"}`.
  `messageId` echoes the client's turn id so a saved draft can name its chart.

SSE frames from Workers AI are OpenAI-shaped: text rides on
`choices[0].delta.content` (or the top-level `response` mirror), and
`delta.reasoning` is **never** surfaced into the transcript. `[DONE]` ends the
turn; a non-`data:` line is a keep-alive.

## 18.3 Context window

`ApplyWindow` keeps principles (policy) plus the newest turns that fit a
24K-token budget (~4 chars/token heuristic, 512 tokens reserved for the
reply). The window never returns empty, and it prunes from the oldest end, so
a long session stays inside the 32K model limit without losing intent.

## 18.4 Persistence order (fail-open chat, fail-closed trading)

A user turn is written to Redis **before** the model runs; the assistant turn
is written after it completes. A crash between the two leaves a transcript gap
(a lost reply), never a lost user intent. Chat availability is therefore
allowed to degrade (REST fallback, reconnect x3) while the trading plane stays
fail-closed.

## 18.5 Deployment note

The chat routes are mounted in the `go-watcher` binary itself — one process,
one port (`:8080`), one Docker service. Mounting is conditional on
`WORKERS_URL` being set, since the AI plane is delegated to the Worker:

```go
if base != "" {
    s := &chat.Service{Store: chat.NewStore(), AI: chat.NewAIClient(base), Origins: origins}
    mux.Handle("/api/chat/", s)
    mux.Handle("/ws/chat/", s)
}
```

Public Pages cannot reach `localhost:8080` (browser local-network rules) —
until a Cloudflare Tunnel or the Hetzner host exposes it, the cloud dashboard
automatically renders the "REST fallback" badge and uses the Worker endpoint.
To point Pages at a public host, build with `VITE_CHAT_BASE` /
`VITE_CHAT_WS_BASE` (wss://), and set `CHAT_ORIGINS` to the allowed WebSocket
origins so the socket rejects foreign `Origin` headers.


## 18.6 Implementation notes

- **Routing.** The service is mounted on a bare prefix (`/api/chat/`), so
  `Service.ServeHTTP` does its own path+method dispatch and
  `r.PathValue("id")` would silently return `""` (it only resolves against Go
  1.22 `ServeMux` patterns). The router stores the id in the request context
  and handlers read it through `chatID(r)`; `TestHandlersReceiveRoutedID`
  pins this.
- **SSE mirror typing.** Workers AI echoes `delta.content` into a top-level
  `response` field with the *same JSON type*, so a numeric answer arrives as
  `"response":2`. Those fields are therefore `json.RawMessage` + `rawText`:
  a `string` field fails the frame's whole unmarshal and the raw JSON leaks to
  the user.
- **CORS.** The chat routes answer `OPTIONS` preflight themselves (204 with
  `allow-methods: GET, POST, DELETE, OPTIONS`), since they are served by the
  Go watcher and not by the Worker's `corsFor` layer.

## 18.7 Chart attachments (ADR-010)

A user turn may carry one chart screenshot. The pipeline:

1. **Client** downscales to a 1568px longest edge, JPEG q0.85 (`downscaleImage` in
   `dashboard/src/lib/api.ts`), and sends it inline over the WS. A 1600x900 chart is
   ~1432 prompt tokens at `detail:"low"` and cost scales with resolution, so the
   downscale is mandatory, not cosmetic.
2. **Go** validates the media type (png/jpeg/webp), the dataUrl↔mediaType match and
   the size cap, stores the turn (with the inline data URL) in Redis, and sends the
   window to the Worker as OpenAI content parts.
3. **Worker** routes the turn to `AI_VISION_MODEL`, persists the decoded bytes to R2
   (`CHAT_MEDIA`) and a metadata row to D1 `chat_attachments`, then streams as usual.
   A missing binding or a storage error is swallowed — chat is advisory.
4. **Cost bound.** Only the newest two image-bearing turns carry bytes; older charts
   become a `[chart image attached earlier]` marker. `ApplyWindow` charges ~1500
   tokens per attachment.

Two probed gotchas are load-bearing: `/no_think` must be appended to the text
**part** (appending to the array yields `"[object Object]"`), and Qwen3 needs both
`reasoning_effort:"low"` and `chat_template_kwargs:{enable_thinking:false}`.

`strategy_drafts.message_id` records the turn id, so "which chart produced this
code?" is a join against `chat_attachments`, not a guess.

