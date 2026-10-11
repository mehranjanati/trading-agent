# AI Trading Agent — Toobit USDT-M Futures (paper-only until gate)

Independent repo. Human approval required before every new order. No live trading, no withdrawals.

- Docs: `docs/` (start: `docs/00-project-charter.md`, `docs/13-development-guide.md`)
- Backlog: `docs/tasks/BACKLOG.json` + `ROADMAP.md`
- Layout: `go-watcher/` (Go WS + watcher) · `workers/` (control plane) · `dashboard/` (SvelteKit — decided Q-01) · `migrations/` (D1, forward-only) · `schemas/` (event/API JSON-schema)

## Architecture at a glance

```mermaid
flowchart TB
    subgraph TBX["Toobit USDT-M Futures"]
        WS["Public WS<br/>ticks + markPrice"]
        REST["Signed REST<br/>orders + reconcile"]
    end
    subgraph HZ["Hetzner — market intake"]
        GO["Go Watcher<br/>WS → normalize → triggers"]
        RD[("Redis<br/>streams + cache")]
        GO --> RD
    end
    subgraph CF["Cloudflare — control plane"]
        W["Workers<br/>API + cron + risk + execution"]
        D[("D1<br/>canonical state")]
        DO["Durable Objects<br/>lease + shards + fanout"]
        GW["AI Gateway<br/>(E07, planned)"]
        W --- D
        W --- DO
    end
    P["Dashboard (SvelteKit)<br/>read-only + approval UI"]
    H["Human Trader<br/>approves every order"]

    WS --> GO
    RD --> W
    W --> REST
    W --- P
    H --- P
    H -. approval .-> W
    W -. "advisory only — never orders" .-> GW
```

Solid = live market path; dashed = human/AI inputs (advisory — never a direct
order path). Execution plane is Cloudflare-only: signed submit + reconcile live
in Workers, canonical state in D1, and the Go Watcher never submits orders
(D-08). Paper-only until the signed gate. Details: `docs/02` (architecture) ·
`docs/03` (components) · `docs/14` (decisions) · `docs/07` (threat model).

## Quickstart (paper mode forced)
```bash
make check   # lint + JSON validate + secret scan
make dev     # local paper-mode stack (no live keys)
```

Safety: never commit secrets. `LIVE_TRADING_ENABLED` does not exist in MVP. See `docs/08-trading-risk-and-execution-safety.md`.
