#!/usr/bin/env bash
set -euo pipefail
fail=0
command -v python3 >/dev/null || { echo "python3 missing"; exit 1; }
# markdown relative-link sanity (docs only)
if grep -rn --include='*.md' '](' docs | grep -v '](http' | grep -v '](./' | grep -v '](../' | grep -v '](#' | grep -v '](docs/' | grep -v '](/'; then echo "WARN: non-relative link found above"; fi
echo "lint: OK"
