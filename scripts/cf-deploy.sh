#!/usr/bin/env bash
# scripts/cf-deploy.sh — one-command Cloudflare deploy for a fresh account.
#
# WHY THIS EXISTS: `wrangler login` (OAuth) has NO R2 scope in its scope list,
# so an OAuth login can never resolve the CHAT_MEDIA binding and deploy dies
# with the misleading "Please enable R2 through the Cloudflare Dashboard
# [code: 10042]". The fix is an API token with Account.R2 (Read) + Storage
# (Edit) — which this script drives non-interactively.
#
# Usage (the only manual step is pasting the token):
#   export CLOUDFLARE_API_TOKEN='<token from dashboard, new account>'
#   ./scripts/cf-deploy.sh
#
# Token recipe (dash.cloudflare.com/profile/api-tokens → Create Token →
# "Edit Cloudflare Workers" template), all under the NEW account:
#   Account.Cloudflare Workers Scripts  Edit
#   Account.Workers R2 Storage          Edit
#   Account.D1                          Edit
#   Account.Workers AI                  Edit
#
# Optional preflight knobs:
#   CF_ACCOUNT_ID   set to skip the wrangler whoami lookup
#   SKIP_MIGRATE=1  do not apply D1 migrations (read-only/CI runs)
set -euo pipefail

cd "$(dirname "$0")/../workers"

# Optional API token. NOT required when `wrangler login` OAuth has R2 access
# on the target account (verified empirically: the old Apjkala25 account was
# missing R2 at the ACCOUNT level — code 10042 — no token could have fixed
# that; this account serves R2 fine over plain OAuth). Set the token only if
# `wrangler r2 bucket list` fails under OAuth.
: "${CLOUDFLARE_API_TOKEN:-}"
# (no export needed — wrangler reads it from the environment when present)

echo "== 1/5 whoami (must show the NEW account)"
wrangler whoami

ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
if [[ -z "$ACCOUNT_ID" ]]; then
  # OAuth logins can hold MULTIPLE accounts; whoami alone is ambiguous then,
  # so only auto-pick when exactly one 32-hex id shows up.
  ACCOUNT_ID="$(wrangler whoami 2>/dev/null | grep -oE '\b[0-9a-f]{32}\b' | sort -u)"
  if [[ $(echo "$ACCOUNT_ID" | grep -c .) -ne 1 ]]; then
    echo "!! multiple/zero accounts found — set CF_ACCOUNT_ID explicitly:" >&2
    echo "$ACCOUNT_ID" >&2
    exit 1
  fi
fi
echo "   target account: $ACCOUNT_ID"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

echo "== 2/5 R2 bucket (CHAT_MEDIA)"
# wrangler cannot create a bucket without R2 scope; if this fails the token is
# missing R2 and the deploy below WILL fail with code 10042. Diagnose here,
# where the message is honest, instead of at the end of an upload.
if wrangler r2 bucket list 2>/dev/null | grep -q 'trading-chat-media'; then
  echo "   bucket trading-chat-media exists"
else
  echo "   creating trading-chat-media ..."
  wrangler r2 bucket create trading-chat-media
fi

echo "== 3/5 D1 database"
if wrangler d1 list 2>/dev/null | grep -q 'trading_dev'; then
  echo "   database trading_dev exists"
else
  echo "   creating trading_dev ..."
  wrangler d1 create trading_dev \
    | tee /tmp/cf-d1-create.txt
  # A fresh account gets a fresh database_id: patch wrangler.toml so the
  # binding below resolves. Without this the Worker boots with no DB.
  NEW_ID="$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /tmp/cf-d1-create.txt | head -n1)"
  if [[ -n "${NEW_ID}" ]]; then
    echo "   patching wrangler.toml database_id -> ${NEW_ID}"
    sed -i '' -E "s/database_id = \"[0-9a-f-]+\"/database_id = \"${NEW_ID}\"/" wrangler.toml
  else
    echo "   !! could not parse database_id; set it by hand in wrangler.toml" >&2
    exit 1
  fi
fi

if [[ "${SKIP_MIGRATE:-}" != "1" ]]; then
  echo "== 4/5 applying migrations"
  wrangler d1 migrations apply trading_dev --remote
else
  echo "== 4/5 migrations skipped (SKIP_MIGRATE=1)"
fi

echo "== 5/5 deploy"
wrangler deploy

echo "== verify"
curl -s -m 10 "https://trading-agent-control.${ACCOUNT_ID:+}.workers.dev/api/health" \
  | head -c 400 || true
echo
echo "done. If /api/health is unreachable, check the worker URL in the deploy output above."
