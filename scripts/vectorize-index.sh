#!/usr/bin/env bash
# scripts/vectorize-index.sh — create the RAG Vectorize index (idempotent).
#
# WHY: Vectorize indexes are account-level resources. A Worker binding that
# points at a missing index makes `wrangler deploy` fail closed with
# "index ... was not found" (code 10159) — which is exactly why the binding
# ships commented in wrangler.toml. Run this once per account, then uncomment
# the binding and redeploy.
#
# Usage:
#   ./scripts/vectorize-index.sh [index] [dimensions] [metric]
#   make vectorize-index
#
# Auth: wrangler reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the
# environment (never from this repo). Dimensions must match the embedding model:
# @cf/baai/bge-m3 emits 1024.
set -euo pipefail

INDEX="${1:-rag-docs-index}"
DIMS="${2:-1024}"
METRIC="${3:-cosine}"

command -v npx >/dev/null 2>&1 || { echo "vectorize: npx/node missing"; exit 1; }

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -z "${CLOUDFLARE_API_KEY:-}" ]]; then
  echo "vectorize: WARN no CLOUDFLARE_API_TOKEN in env — wrangler will prompt/refuse"
fi

# Idempotent: `wrangler vectorize create` fails when the index already exists,
# so check the list first instead of swallowing an error blindly.
if npx --yes wrangler vectorize list 2>/dev/null | grep -qF -- "$INDEX"; then
  echo "vectorize: index '$INDEX' already exists — nothing to do"
  exit 0
fi

echo "vectorize: creating '$INDEX' (dimensions=$DIMS, metric=$METRIC)…"
npx --yes wrangler vectorize create "$INDEX" --dimensions="$DIMS" --metric="$METRIC"
echo "vectorize: created."
echo "next: uncomment the [[vectorize]] block in wrangler.toml AND workers/wrangler.toml,"
echo "      redeploy, then run the ingest route (scripts/ingest-vectorize.mjs)."
