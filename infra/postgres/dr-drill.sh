#!/usr/bin/env bash
# End-to-end DR drill on THROWAWAY local Postgres clusters (no cloud, no shared state). It exercises exactly the commands in
# docs/ops/backup-restore.md and docs/ops/dr-runbook.md:
#   1. primary with WAL archiving      2. base backup (pg_basebackup)      3. streaming replica (pg_basebackup -R) + lag
#   4. point-in-time recovery to just before a "bad" change                5. replica promotion (failover)
#   6. rebuild of the old primary as a replica with pg_rewind (failback)   7. logical dump/restore round trip
# Usage:  bash infra/postgres/dr-drill.sh            (needs Postgres >= 15 binaries on PATH or in PGBIN)
# Ports 55432-55435 and a temp dir are used; everything is removed on exit. Exit code 0 = every step verified.
set -euo pipefail
PGBIN="${PGBIN:-$(dirname "$(command -v initdb)")}"
export PATH="$PGBIN:$PATH"
W="$(mktemp -d "${TMPDIR:-/tmp}/cnote-dr-drill.XXXXXX")"
P_PORT=55432 R_PORT=55433 T_PORT=55434 F_PORT=55435
step() { printf '\n== %s\n' "$*"; }
fail() { echo "DRILL FAILED: $*" >&2; exit 1; }
stop_all() { for d in primary replica pitr; do [ -d "$W/$d" ] && pg_ctl -D "$W/$d" -m immediate stop >/dev/null 2>&1 || true; done; rm -rf "$W"; }
trap stop_all EXIT
q() { local port=$1; shift; psql -h 127.0.0.1 -p "$port" -U postgres -d drill -Atqc "$*"; }
waitready() { for _ in $(seq 1 60); do pg_isready -h 127.0.0.1 -p "$1" -q && return 0; sleep 0.5; done; fail "postgres on $1 did not become ready"; }

step "1. primary with WAL archiving"
initdb -D "$W/primary" -U postgres --auth=trust >/dev/null
mkdir -p "$W/archive" "$W/backup"
cat >> "$W/primary/postgresql.conf" <<CONF
port = $P_PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$W'
wal_level = replica
archive_mode = on
archive_timeout = 5s
archive_command = 'test ! -f $W/archive/%f && cp %p $W/archive/%f'
max_wal_senders = 5
wal_keep_size = 64MB
wal_log_hints = on
hot_standby = on
CONF
echo "host replication all 127.0.0.1/32 trust" >> "$W/primary/pg_hba.conf"
pg_ctl -D "$W/primary" -l "$W/primary.log" -w start >/dev/null
createdb -h 127.0.0.1 -p $P_PORT -U postgres drill
q $P_PORT "CREATE TABLE orders(id serial primary key, note text, at timestamptz default now()); INSERT INTO orders(note) SELECT 'row-'||g FROM generate_series(1,100) g;"

step "2. base backup + verification"
pg_basebackup -h 127.0.0.1 -p $P_PORT -U postgres -D "$W/backup/base" -X none -c fast --manifest-checksums=sha256
pg_verifybackup --no-parse-wal "$W/backup/base" >/dev/null || fail "pg_verifybackup"

step "3. streaming replica (pg_basebackup -R) and replication lag"
pg_basebackup -h 127.0.0.1 -p $P_PORT -U postgres -D "$W/replica" -R -X stream -c fast
echo "port = $R_PORT" >> "$W/replica/postgresql.conf"
pg_ctl -D "$W/replica" -l "$W/replica.log" -w start >/dev/null
waitready $R_PORT
q $P_PORT "INSERT INTO orders(note) SELECT 'after-replica-'||g FROM generate_series(1,50) g;"
for _ in $(seq 1 40); do [ "$(q $R_PORT 'SELECT count(*) FROM orders')" = "150" ] && break; sleep 0.25; done
[ "$(q $R_PORT 'SELECT count(*) FROM orders')" = "150" ] || fail "replica did not catch up"
[ "$(q $R_PORT 'SELECT pg_is_in_recovery()')" = "t" ] || fail "replica is not in recovery"
LAG=$(q $P_PORT "SELECT coalesce(extract(epoch from max(replay_lag)),0) FROM pg_stat_replication")
echo "replica caught up (150 rows); reported replay_lag=${LAG}s"

step "4. point-in-time recovery (drop a table by mistake, recover to just before)"
q $P_PORT "SELECT pg_switch_wal()" >/dev/null
sleep 1
TARGET=$(q $P_PORT "SELECT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US')||'+00'")
sleep 1
q $P_PORT "DROP TABLE orders" && q $P_PORT "SELECT pg_switch_wal()" >/dev/null
sleep 2  # archive_timeout=5s / switch: make sure the segment holding the DROP is archived too
cp -R "$W/backup/base" "$W/pitr"
chmod 700 "$W/pitr"
cat >> "$W/pitr/postgresql.conf" <<CONF
port = $T_PORT
restore_command = 'cp $W/archive/%f %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
CONF
touch "$W/pitr/recovery.signal"
pg_ctl -D "$W/pitr" -l "$W/pitr.log" -w start >/dev/null || { cat "$W/pitr.log" >&2; fail "PITR start"; }
waitready $T_PORT
for _ in $(seq 1 60); do [ "$(q $T_PORT 'SELECT pg_is_in_recovery()')" = "f" ] && break; sleep 0.5; done
GOT=$(q $T_PORT "SELECT count(*) FROM orders") || fail "orders table missing after PITR"
[ "$GOT" = "150" ] || fail "PITR restored $GOT rows, expected 150"
echo "PITR to $TARGET restored the dropped table with 150 rows"
pg_ctl -D "$W/pitr" -m fast stop >/dev/null

step "5. failover: promote the replica"
# the replica also replayed the DROP (streaming replication is not a backup): use a fresh scenario for promotion
q $R_PORT "SELECT count(*) FROM information_schema.tables WHERE table_name='orders'" | grep -qx 0 || fail "expected the DROP to have replicated (that is why PITR exists)"
pg_ctl -D "$W/replica" -w promote >/dev/null
for _ in $(seq 1 40); do [ "$(q $R_PORT 'SELECT pg_is_in_recovery()')" = "f" ] && break; sleep 0.25; done
[ "$(q $R_PORT 'SELECT pg_is_in_recovery()')" = "f" ] || fail "promotion"
q $R_PORT "CREATE TABLE failover_marker(ok bool); INSERT INTO failover_marker VALUES (true)"
echo "replica promoted and writable"

step "6. failback: rebuild the old primary as a replica with pg_rewind"
pg_ctl -D "$W/primary" -m fast stop >/dev/null
pg_rewind --target-pgdata="$W/primary" --source-server="host=127.0.0.1 port=$R_PORT user=postgres dbname=postgres" >/dev/null
# pg_rewind copies config files from the source too (the promoted node's port etc.): re-apply this node's own settings.
cat >> "$W/primary/postgresql.conf" <<CONF
port = $P_PORT
archive_mode = off
CONF
cat >> "$W/primary/postgresql.auto.conf" <<CONF
primary_conninfo = 'host=127.0.0.1 port=$R_PORT user=postgres'
CONF
touch "$W/primary/standby.signal"
pg_ctl -D "$W/primary" -l "$W/primary2.log" -w start >/dev/null || { tail -20 "$W/primary2.log" >&2; fail "old primary did not start as a replica"; }
waitready $P_PORT
for _ in $(seq 1 40); do [ "$(q $P_PORT "SELECT count(*) FROM failover_marker" 2>/dev/null || echo 0)" = "1" ] && break; sleep 0.25; done
[ "$(q $P_PORT 'SELECT count(*) FROM failover_marker')" = "1" ] || fail "old primary did not follow the new primary"
[ "$(q $P_PORT 'SELECT pg_is_in_recovery()')" = "t" ] || fail "old primary is not a replica"
echo "old primary is now a replica of the promoted node (promote it back to complete the failback)"

step "7. logical dump/restore round trip (pg_dump -Fc / pg_restore)"
pg_dump -h 127.0.0.1 -p $R_PORT -U postgres -d drill -Fc -f "$W/drill.dump"
createdb -h 127.0.0.1 -p $R_PORT -U postgres drill_restored
pg_restore -h 127.0.0.1 -p $R_PORT -U postgres -d drill_restored --no-owner --exit-on-error "$W/drill.dump"
[ "$(psql -h 127.0.0.1 -p $R_PORT -U postgres -d drill_restored -Atqc 'SELECT count(*) FROM failover_marker')" = "1" ] || fail "dump/restore"
echo "dump restored"

printf '\nDR DRILL PASSED (PG %s)\n' "$(postgres --version | awk '{print $3}')"
