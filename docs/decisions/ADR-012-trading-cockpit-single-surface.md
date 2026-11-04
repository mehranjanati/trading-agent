# ADR-012 — Trading Cockpit: one surface instead of seventeen URLs

Status: PROPOSED 2026-11-01 | Relates: docs/09 §9.1, docs/20, ADR-003, D-04 (Q-01), D-08

## Context
The SvelteKit dashboard shipped eleven documented routes (docs/09 §9.1) and then
grew to seventeen URLs as the setup-room, analysis, and chat features landed. The
growth was **navigation**, not capability: every new view read the same read-only BFF
endpoints, and several pairs render literally the same rows
(`/watches` vs `/zones`, `/analysis` vs `/analyze`, `/approvals` vs `/orders`,
`/signals`+`/events`+`/logs`+`/failover` all over `recovery_log`/`events`).

The trader's actual question — "what is happening on this symbol right now, and
what can I do about it?" — is answered by combining the symbol list, the live
quote, the watch board, the last analysis, the assistant, and the pending
approval. Every one of those already exists; they are simply on six different
URLs, so the answer requires five navigations and loses the context of the
previous one.

The alternative "fix" (more cross-links between the existing pages) was rejected:
it multiplies the navigation graph instead of shrinking it, and the freshness
badge / mode banner / UNAVAILABLE rules still have to be re-implemented per page.

## Decision
Consolidate the dashboard into **one cockpit + three secondary views**:

- `/cockpit` (default) — symbol sidebar with live price, watch board for the
  selected symbol (every status, ACTIVE first), inline advisory chat, inline
  analysis panel + Stalk card.
- `/execution` — approvals queue, intents → orders → fills, positions (fills only).
- `/activity` — one tabbed timeline: signals · events · errors/gaps · failover/drills.
- `/settings` — strategy library/groups/drafts, risk-limit versions (read-only),
  Telegram topics.

Legacy URLs are kept alive by **SvelteKit-level 302 redirects** with state
preserved in query parameters (docs/20 §20.5), so bookmarks, Telegram alert
links, and chat-emitted links never 404 and never lose the symbol.

Hard constraints (unchanged by this ADR):

1. The dashboard stays **read-only** (D-08). The only write remains
   `POST /api/watches`; approvals and orders render with no action button.
2. **One freshness badge per widget**, the global mode banner, explicit
   UNAVAILABLE, and gap-explicit timelines survive the merge (docs/09 §9.2/§9.4).
3. The **BFF contract does not change**; a panel that would need a missing
   endpoint renders UNAVAILABLE instead of inventing data.
4. New pure logic goes into `*-core.mjs` modules so `node --test` can exercise it
   without a browser (the `freshness.mjs` / `setups-core.mjs` pattern).

## Alternatives
- **A — keep seventeen URLs, add cross-links**: rejected; navigation complexity is
  the problem, and each page keeps re-deriving badges and empty states.
- **B — one giant page, no routes**: rejected; `/execution` and `/activity` are
  genuinely different jobs (money vs. forensics) and are worth their own URL.
- **C — server-side redirect in the Worker**: rejected; the dashboard's routing is
  a SvelteKit concern, and putting it in the BFF would change a read-only API
  contract for a UI decision.
- **D — add approve/execute buttons to the cockpit**: rejected here; that is a
  permission change (D-08 / SAFE-002) and needs its own ADR + security review.

## Consequences
- Fewer pages, fewer duplicated derivations (badge/empty-state logic lives once).
- A trader reaches "watch armed" from "symbol on screen" without a page change.
- The legacy routes become redirect stubs; deleting them is gated on the redirect
  being live in production (docs/20 §20.6).
- Docs/09 §9.1 stays the record of what shipped (E10-T01); docs/20 is the target
  information architecture and wins on conflict for new UI work.

## Verification
- `docs/20` §20.8 acceptance list (redirects, badge coverage, one-surface flow).
- `npm run check` + `npm test` (dashboard) stay green.
- Manual: every URL in docs/20 §20.5 opens the mapped state with the mode banner
  and the paper-sim venue notice visible.
