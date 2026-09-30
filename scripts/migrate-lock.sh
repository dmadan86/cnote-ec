#!/usr/bin/env bash
# Serialises schema edits + migrations when several agents/devs work in one checkout (Prisma's diff would otherwise
# fold another in-flight schema edit into your migration).  Usage:
#   bash scripts/migrate-lock.sh acquire <owner>   # blocks until held (stale after 20 min)
#   <edit your packages/db/prisma/schema/<module>.prisma> ; pnpm db:new <name> ; pnpm db:migrate ; pnpm db:test:prepare
#   bash scripts/migrate-lock.sh release <owner>
set -euo pipefail
LOCK="${TMPDIR:-/tmp}/cnote-migrate.lock"
cmd="${1:-}"; owner="${2:-unknown}"
case "$cmd" in
  acquire)
    for _ in $(seq 1 720); do
      if mkdir "$LOCK" 2>/dev/null; then echo "$owner $(date +%s)" > "$LOCK/owner"; echo "lock acquired by $owner"; exit 0; fi
      if [ -f "$LOCK/owner" ]; then
        read -r who ts < "$LOCK/owner" || true
        if [ -n "${ts:-}" ] && [ $(( $(date +%s) - ts )) -gt 1200 ]; then echo "breaking stale lock held by $who"; rm -rf "$LOCK"; continue; fi
      fi
      sleep 5
    done
    echo "timed out waiting for migrate lock" >&2; exit 1 ;;
  release)
    if [ -f "$LOCK/owner" ] && [ "$(cut -d' ' -f1 "$LOCK/owner")" != "$owner" ]; then echo "lock held by someone else; not releasing" >&2; exit 1; fi
    rm -rf "$LOCK"; echo "lock released by $owner" ;;
  status) cat "$LOCK/owner" 2>/dev/null || echo "free" ;;
  *) echo "usage: $0 acquire|release|status <owner>" >&2; exit 2 ;;
esac
