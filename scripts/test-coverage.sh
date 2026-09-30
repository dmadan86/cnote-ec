#!/usr/bin/env bash
# Runs every workspace that defines a vitest.config.ts with coverage thresholds enforced
# (vitest.shared.ts). Fails if any package misses its thresholds or has failing tests.
set -uo pipefail
cd "$(dirname "$0")/.."
status=0
for dir in packages/* apps/*; do
  [ -f "$dir/vitest.config.ts" ] || continue
  echo "── $dir"
  if ! (cd "$dir" && npx vitest run --coverage --coverage.reporter=text-summary); then
    echo "✗ $dir failed (tests or coverage thresholds)"
    status=1
  fi
done
exit $status
