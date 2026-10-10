#!/usr/bin/env bash
set -euo pipefail
# Self-excluding scan: skip this script file itself to avoid matching its own pattern.
pat='AKIA[0-9A-Z]{16}|sk-live|TOOBIT_API_SECRET.{0,3}=.{4,}'
if grep -rniE "$pat" --exclude-dir=node_modules --exclude-dir=.git --exclude='secret-scan.sh' --exclude='*.md' --exclude='.env.example' . ; then echo "secret-scan: FAIL (possible secret)"; exit 1; fi
echo "secret-scan: OK"
