#!/usr/bin/env bash
# dev-tunnel.sh — expose the LOCAL go-watcher (docker ta-go-watcher :8080) via a
# cloudflared QUICK tunnel and print the URL to set as GO_WATCHER_URL.
#
# WHY THIS EXISTS: 2026-11-10 — the Render origin (trading-agent-knpg.onrender.com)
# started answering 429/challenge to server-to-server fetches (Cloudflare bot
# mitigation in front of Render), which broke the Worker's /analyze and
# /strategies/registry proxy. The Mac container is already the live heartbeat +
# trigger-loop plane, so the analysis plane moved onto it behind a tunnel.
#
# QUICK-TUNNEL CAVEAT (read before relying on this):
#   - the *.trycloudflare.com URL is EPHEMERAL: it changes every time this
#     script restarts (and dies on reboot). After restarting, re-deploy the
#     Worker with the new URL:
#       cd workers && wrangler deploy \
#         --var GO_WATCHER_URL:https://<new-url>.trycloudflare.com
#   - a deploy WITHOUT --var (e.g. CI from git) reverts GO_WATCHER_URL to the
#     wrangler.toml default (Render).
#   - durable alternative: `cloudflared tunnel login` + a NAMED tunnel gives a
#     stable URL (needs one interactive browser login — account scope).
#
# usage: scripts/dev-tunnel.sh          # start tunnel, print URL
set -euo pipefail
command -v cloudflared >/dev/null || { echo "cloudflared not installed (brew install cloudflared)" >&2; exit 1; }
curl -s --max-time 5 http://localhost:8080/healthz >/dev/null || {
  echo "local go-watcher not answering on :8080 — start it first: docker compose up -d go-watcher" >&2
  exit 1
}
pkill -f "cloudflared tunnel" 2>/dev/null || true
LOG="${TMPDIR:-/tmp}/cfd.log"
nohup cloudflared tunnel --url http://localhost:8080 >"$LOG" 2>&1 &
sleep 8
URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -n 1 || true)"
if [[ -z "$URL" ]]; then echo "tunnel did not come up — see $LOG" >&2; exit 1; fi
echo "tunnel: $URL"
echo "verify: curl $URL/healthz   (expect: ok)"
echo "switchover:"
echo "  cd workers && wrangler deploy --var GO_WATCHER_URL:$URL"
