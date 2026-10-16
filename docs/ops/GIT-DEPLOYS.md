# Git-backed deploys (Cloudflare builds from this repo — no local `wrangler deploy`).
#
# Connect once in the dashboard, then every push to `main` rebuilds both
# projects automatically. Repo-side prerequisites are already in the tree;
# ONLY the dashboard clicks below remain (bindings/secrets live in the CF
# account, never here).
#
# ## 1. trading-agent-control (Worker + cron)
# Dashboard → Workers & Pages → ... → "Add to git" (or: Create application →
# Workers → Connect to Git). Settings:
#   - Repo/branch: mehranjanati/trading-agent → main
#   - Root directory: workers          (wrangler.toml lives there)
#   - Build command: (leave default — wrangler deploy runs it)
#   - Deploy command: npx wrangler deploy
#   - `compatibility_flags = ["nodejs_compat"]` is committed in
#     workers/wrangler.toml (node:crypto without it warns/fails).
#   - D1 migrations: wrangler.toml points at ../migrations. If a build fails
#     with "migrations directory not found", set the Root directory to the
#     REPO ROOT and Deploy command to:
#       npx wrangler deploy --config workers/wrangler.toml
#     (this keeps ../migrations inside the build context).
#   - Bindings/secrets to re-attach in the Worker settings (NOT in git):
#       D1:  trading_dev (2f21170c-1a7f-4512-a11f-68ddd473f4a6) — or create a
#            fresh `trading_prod` database for the production Worker
#       R2:  CHAT_MEDIA → trading-chat-media
#       AI:  binding AI (Workers AI)
#       KV:  SYMBOLS_KV (only if the symbols-allowlist rollout landed)
#       Vars (plain): ENV, HUMAN_APPROVAL_REQUIRED, AI_MODEL,
#            AI_MODEL_FALLBACK, AI_VISION_MODEL, EXCHANGE, TOOBIT_BASE
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
