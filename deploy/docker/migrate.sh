#!/bin/sh
# Apply pending migrations. Idempotent: `migrate deploy` only applies migrations not yet recorded.
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"

echo "[migrate] authoring database (@cnote/db)"
pnpm --filter @cnote/db migrate:deploy

if [ -n "${LIVE_DATABASE_URL:-}" ]; then
  echo "[migrate] live read database (@cnote/live-db)"
  pnpm --filter @cnote/live-db migrate:deploy
else
  echo "[migrate] LIVE_DATABASE_URL not set; skipping live database"
fi
echo "[migrate] done"
