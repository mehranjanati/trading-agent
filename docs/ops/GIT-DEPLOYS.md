# Git-backed deploys (Cloudflare builds from this repo — no local `wrangler deploy`).
#
# Connect once in the dashboard, then every push to `main` rebuilds both
# projects automatically. Repo-side prerequisites are already in the tree;
# ONLY the dashboard clicks below remain (bindings/secrets live in the CF
# account, never here).
#
# ## 1. trading-agent-control (Worker + cron)
# Dashboard → Workers & Pages → ... → "Add to git" (or: Create application →
# Workers → Connect to Git). Settings (VALIDATED 2026-10-16 — the two wrong
# combos are listed below so nobody re-tries them):
#   - Repo/branch: mehranjanati/trading-agent → main
#   - Root directory: LEAVE EMPTY (repo root). The ROOT wrangler.toml is the
#     git-build entry (main = workers/src/index.mjs, migrations_dir =
#     migrations); it mirrors workers/wrangler.toml's name/vars/bindings.
#   - Build command: (leave empty — nothing to compile; wrangler deploys raw JS.)
#     Cloudflare still auto-runs `npm ci` at the build root whenever a
#     package.json is present — the ROOT package.json/package-lock.json exist
#     ONLY for that (pinned wrangler, no workspaces). If you touch root
#     package.json, re-run `npm install --package-lock-only` at the root or the
#     next build fails with "npm ci can only install packages when your
#     package.json and package-lock.json are in sync" (hit 2026-10-16 12:05).
#   - Deploy command (exact): `npx wrangler deploy` — it picks up the ROOT
#     wrangler.toml at cwd. KEEP workers/wrangler.toml as the local-dev
#     entry (scripts/cf-deploy.sh cds into workers/); sync name/vars/bindings
#     between the two files when either changes.
#   WHY NOT other combos:
#     * Root=repo-root + `npx wrangler deploy` with NO root wrangler.toml:
#       FAILS with "Could not detect a directory containing static files" —
#       wrangler finds no wrangler.toml at cwd and assumes a static-assets
#       project. THIS WAS THE 2026-10-16 10:51 BUILD FAILURE; the root
#       wrangler.toml (added 2026-10-16) closes it.
#     * Root=workers + `npx wrangler deploy` (no --config): untested; only use
#       with Deploy command `npx wrangler deploy --config workers/wrangler.toml`
#       if you insist on Root=workers.
#   - `compatibility_flags = ["nodejs_compat"]` is committed in
#     workers/wrangler.toml (node:crypto without it warns/fails).
#   - Bindings/secrets to re-attach in the Worker settings (NOT in git):
#       D1:  trading_dev (2f21170c-1a7f-4512-a11f-68ddd473f4a6) — or create a
#            fresh `trading_prod` database for the production Worker
#       R2:  CHAT_MEDIA → trading-chat-media
#       AI:  binding AI (Workers AI)
#       KV:  SYMBOLS_KV (only if the symbols-allowlist rollout landed)
#       Vars (plain): ENV, HUMAN_APPROVAL_REQUIRED, AI_MODEL,
#            AI_MODEL_FALLBACK, AI_VISION_MODEL, EXCHANGE, TOOBIT_BASE.
#            GO_WATCHER_URL is BAKED IN (root wrangler.toml [vars] +
#            proxy.mjs DEFAULT_WATCHER_URL = https://trading-agent-knpg.onrender.com)
#            so unconfigured git builds still proxy; a dashboard-level var
#            overrides it per env when you need to point at a new watcher host.
#            (E14-T02 proxy base for /analyze + /strategies/registry — the
#            dashboard falls back to the Worker itself when VITE_* unset)
#       Secrets (wrangler secret put — never commit):
#            SIGNAL_HMAC_SECRET (or SIGNAL_HMAC_SECRETS), GO_HEARTBEAT_TOKEN
# After connect: any push touching workers/** rebuilds and redeploys.
#
# ## 2. trading-agent-dashboard (Pages, SvelteKit)
# Dashboard → your Pages project → Settings → Builds & deployments →
# "Connect to Git" (or recreate from Git with the SvelteKit preset).
# Settings:
#   - Repo/branch: mehranjanati/trading-agent → main (production branch)
#   - Root directory: dashboard
#   - Framework preset: SvelteKit  (build: npm run build,
#     output: .svelte-kit/cloudflare)
#   - Node version: dashboard/.node-version pins Node 20 for both Pages and
#     the GitHub `dashboard` CI job.
#   - Variables and Secrets → Production (+ Preview if you use them):
#       VITE_API_BASE      = https://trading-agent-control.<acct>.workers.dev
#       VITE_ANALYZE_BASE  = https://trading-agent-knpg.onrender.com
#       VITE_CHAT_BASE     = https://trading-agent-knpg.onrender.com
#       VITE_CHAT_WS_BASE  = wss://trading-agent-knpg.onrender.com
#     (VITE_* bake at BUILD time — changing a value requires a rebuild/retry,
#     not just a variable save.)
#   - Build watch paths: add `dashboard/**` so pushes that only touch
#     workers/ or go-watcher/ SKIP the dashboard rebuild (and vice versa —
#     set `workers/**` on the Worker project).
#
# ## Render (unchanged — reference only)
# go-watcher + Key Value already run on Render (trading-agent-knpg.onrender.com).
# Render is NOT git-autobuilt from this doc's scope: its Web Service
# auto-deploys on main already.
