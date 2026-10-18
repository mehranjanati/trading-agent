#!/usr/bin/env bash
# secret-scan.sh — shape-based scan, CI-enforced. TS+Go stack: no Python.
set -euo pipefail
# Self-excluding: skip this script. .env.example allowed (placeholders only, enforced below).
pat='AKIA[0-9A-Z]{16}|sk-live-[A-Za-z0-9]{8,}|xox[bap]-|ghp_[A-Za-z0-9]{8,}|TOOBIT_API_SECRET[\"\x27 ]{0,3}[:=][\"\x27 ]{0,3}[A-Za-z0-9/+_=]{8,}'
# Toolchain/build caches are gitignored local tooling (.toolchain/, .gopath/,
# .gocache/ — see .gitignore): they hold compiler test fixtures that can look
# like secret shapes (e.g. Go's buildinfo base64), never repo content.
if grep -rniE "$pat" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.toolchain \
  --exclude-dir=.gopath --exclude-dir=.gocache --exclude-dir=.svelte-kit \
  --exclude='secret-scan.sh' --exclude='*.md' --exclude='.env.example' --exclude='*.mjs' --exclude='BACKLOG.json' . ; then
  echo "secret-scan: FAIL (possible secret shape)"; exit 1
fi
# .env.example must contain only placeholders
if grep -niE 'secret[^ ]*=[^ ]*[A-Za-z0-9]{12,}' .env.example | grep -vi 'placeholder\|example\|verify-required\|set-via' ; then
  echo "secret-scan: FAIL (.env.example has real-looking value)"; exit 1
fi
echo "secret-scan: OK"

