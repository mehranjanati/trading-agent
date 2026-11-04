# ADR-014 — Durable chat transcripts (D1 canonical, Redis cache, R2 bytes)

Status: ACCEPTED 2026-11-04 | Relates: docs/04, docs/18, ADR-002, ADR-010, D-08

## Context
A cockpit conversation kept disappearing. The cause was structural, not a UI bug:

1. **Redis-only, 24h TTL.** `go-watcher/chat/store.go` wrote turns to
   `chat:{id}:msgs` and refreshed `EXPIRE 86400`; after a day of inactivity (or a
   Redis restart) the transcript was gone.
2. **Session id lived only in the browser.** `POST /api/chat/create` minted a
   random `chat_<ts>_<rand>` and the dashboard kept it in
   `localStorage["chat_session_{symbol}"]`. Another device, a cleared storage or
   an incognito window meant a brand-new empty thread — nothing tied a symbol to
   its conversation server-side.
3. **The deployed Pages site runs the REST path.** `chatServiceUp()` returns
   `false` when `CHAT_BASE` contains `workers.dev`, so messages were written to
   `localStorage` only (`chat_messages_{symbol}`) and never left the browser.
4. **D1 held only attachment metadata.** `chat_attachments` (0005) kept the R2
   key/sha of a chart, but the message text was never persisted anywhere durable.

## Decision
- **D1 is canonical.** Two new tables (`migrations/0011_chat_persistence.sql`):
  `chat_sessions(id, symbol, principles, created_at, updated_at)` and
  `chat_messages(id, session_id, role, content, attachments_json, message_id, at)`.
- **One permanent thread per symbol:** `session_id = "sym_<SYMBOL>"`
  (`sym_OPENUSDT`), derived identically on all three planes
  (`chat.SessionIDForSymbol`, `workers/src/chat-store.mjs:sessionIdForSymbol`,
  `dashboard/src/lib/chat-widget-core.mjs:roomSessionId`). A partial UNIQUE index
  on `chat_sessions(symbol)` makes a second thread for one symbol impossible.
  The legacy floating widget keeps its random id with `symbol = ''`.
- **Redis stays a cache.** The 24h TTL is unchanged and now harmless: a miss
  reads D1 and rehydrates the window (`Store.Messages`). A Redis outage serves
  the canonical log instead of failing the read.
- **Write-through on every turn, from both writers.** The Go service mirrors each
  `Append` to `POST /api/chat:append` (through the Worker — Go never writes D1,
  D-08); the browser REST fallback posts the same route after each answer, so a
  deployment without the Go service is durable too. Both are fail-soft: a
  durable-log outage degrades to "not stored", never to a silenced answer.
- **Bytes stay in R2.** `attachments_json` carries metadata only
  (`mediaType/detail/bytes`); an inline data URL is stripped before the D1 write
  (2 MB row cap, ADR-010).
- **Delete clears both stores** (`POST /api/chat:delete`), otherwise the
  transcript would reappear from D1 on the next read.
- **Read API:** `GET /api/chat:history?session=&limit=` (oldest first, cap 500).

## Alternatives
- **A — keep Redis-only with a longer TTL**: rejected; a restart still loses it
  and per-symbol threads still do not exist.
- **B — R2 JSONL transcript**: rejected as the primary store; per-symbol queries
  and per-turn appends are natural in D1, and R2 is already the blob store.
- **C — browser-only IndexedDB**: rejected; same class as the bug (another device
  sees nothing) and not auditable.
- **D — Go writes D1 directly**: rejected; D-08 keeps every D1 write in Workers.
- **E — one thread per (symbol, session) with a history list**: deferred; the
  chosen model is one permanent thread per symbol (explicit user decision,
  2026-11-04). The schema already allows a later `symbol + created_at` list.

## Consequences
- A cockpit conversation now survives a day, a Redis restart, a browser change
  and a cleared storage. The `sym_` id is derived, so nothing depends on
  localStorage remembering it.
- Transcripts are advisory data in D1: no watch/order/approval authority, no
  effect on risk gates (D-08, SAFE-003 unchanged).
- Growth is bounded by `MAX_CONTENT` (32k chars/turn), `MAX_ATTACHMENTS` (4) and
  the read cap (500 rows). Retention beyond that is a future policy decision
  (chat is not audit-critical like `events`).
- If D1 write fails, `recovery_log` is not written and the turn is simply not
  durable — the user is never blocked (fail-open, as before).

## Verification
- `workers/src/chat-store.test.mjs`: session-id derivation (fail closed), metadata-only
  attachments, `normalizeTurn` validation, and an append → history → delete flow
  against an in-memory D1 fake (the "chat disappears" regression).
- `go-watcher/chat/persist_test.go`: `SessionIDForSymbol`, the persister against an
  `httptest` Worker (append body, metadata-only, history query, delete), nil-safety.
- `dashboard/src/lib/chat-widget-core.test.mjs`: `roomSessionId` mirrors the servers.
- `make check` green (CI: Redis-free by design, docs/13 §13.8).
