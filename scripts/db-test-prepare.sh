#!/usr/bin/env bash
# Create/migrate the isolated test databases used by vitest (see vitest.setup.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
# Value of KEY in .env.local, or empty. Must succeed when the file or key is absent (set -e + pipefail).
envval() { [ -f .env.local ] || return 0; { grep -E "^$1=" .env.local || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
base="${DATABASE_URL:-$(envval DATABASE_URL)}"; base="${base:-postgres://cnote:cnote@localhost:5432/cnote}"
live="${LIVE_DATABASE_URL:-$(envval LIVE_DATABASE_URL)}"; live="${live:-postgres://cnote:cnote@localhost:5432/cnote_live}"
export DATABASE_URL="${TEST_DATABASE_URL:-${base%/*}/$(basename "${base%%\?*}")_test}"
export LIVE_DATABASE_URL="${TEST_LIVE_DATABASE_URL:-${live%/*}/$(basename "${live%%\?*}")_test}"
echo "authoring: $DATABASE_URL"; echo "live:      $LIVE_DATABASE_URL"
pnpm --filter @cnote/db exec prisma migrate deploy
pnpm --filter @cnote/live-db migrate:deploy
bash scripts/allow-test-purge.sh "$DATABASE_URL"   # test cleanup deletes from the DB-level append-only tables (M5)
