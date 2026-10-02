#!/usr/bin/env bash
# TEST/E2E/DEV databases only. Makes every new connection to the given database start with `cnote.allow_purge = on`, so test
# cleanup (`deleteMany` on credit_ledger, consents, domain_events, ...) can DELETE from the append-only tables whose DB
# triggers otherwise reject it (security audit M5, migration 20261003000000_append_only_triggers). UPDATE stays blocked, so
# app code that mutates an append-only row still fails the suite. NEVER run this against a production database.
#   bash scripts/allow-test-purge.sh postgres://cnote:cnote@localhost:5432/cnote_test
set -euo pipefail
url="${1:?usage: allow-test-purge.sh <database url>}"
psql "$url" -v ON_ERROR_STOP=1 -q -c "DO \$\$ BEGIN EXECUTE format('ALTER DATABASE %I SET cnote.allow_purge = ''on''', current_database()); END \$\$;"
echo "append-only purge default enabled for $(psql "$url" -Atc 'select current_database()')"
