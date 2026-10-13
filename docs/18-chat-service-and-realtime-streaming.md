# 18 — Chat Service & Real-Time Strategy Authoring

> Advisory plane only. The chat service never touches watches, orders,
> approvals, leases or kill-switch state; its only writes are its own Redis
> keys (`chat:*`). D-08 (no order submission from the dashboard) is unchanged:
> the AI path ends in a `strategy_drafts` row with status `generated`.

## 18.1 Shape (v2-vibe pattern, trading-scoped)

| Piece | Where | Role |
|---|---|---|
| Session store | Redis (`ta-redis`) | `chat:{id}:meta` HASH{created_at, principles} + `chat:{id}:msgs` LIST of JSON turns, both 24h TTL, refreshed on write |
| Chat service | `go-watcher/cmd/chatd` (:8081) | HTTP for session CRUD, WebSocket for the turn loop |
| AI plane | Worker `POST /api/strategy:chat:stream` | owns the `AI` binding (no keys in Go); passes the model's SSE through untouched, reports the model on `x-ai-model` |
| Client | dashboard `/chat` | WS when chatd is reachable, Worker REST (`/api/strategy:chat`) otherwise |

## 18.2 Contract

HTTP (chatd):

- `POST /api/chat/create {principles?}` -> `201 {id}`
- `GET /api/chat/{id}` -> `200 {messages[], principles}` (empty for unknown/TTL-expired id)
- `DELETE /api/chat/{id}` -> `200 {deleted:true}`
- `POST /api/chat/{id}/principles {content}` -> `200 {saved:true}`

WebSocket `/ws/chat/{id}` — client sends `{"type":"message"|"principles","content"}`,
server sends `{"type":"chunk","text"}`* then `{"type":"done","text","codeBlocks","model"}`,
or `{"type":"error","error"}`. The socket stays open for the next turn.

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

`chatd` shares the `go-watcher` image (prebuilt binary `docker/chatd`,
entrypoint override in compose). Local dev: `:8081`. Public Pages cannot reach
`localhost:8081` (browser local-network rules) — until a Cloudflare Tunnel or
the Hetzner host exposes it, the cloud dashboard automatically renders the
"REST fallback" badge and uses the Worker endpoint. To point Pages at a public
chatd, build with `VITE_CHAT_BASE`/`VITE_CHAT_WS_BASE` (wss://).
