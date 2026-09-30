# Backup and restore (PostgreSQL 17, Redis, object storage)

All commands below were exercised on PostgreSQL 17.11 by `bash infra/postgres/dr-drill.sh` (scratch clusters on localhost;
the script prints `DR DRILL PASSED`). Cloud-managed Postgres (RDS, Cloud SQL, Azure Database) offers the same capabilities as
parameter groups and console/CLI operations: automated backups with PITR (retention 14-35 days), cross-region read replica
(in the OTHER India region), snapshot copy to the other India region. Use those when managed, and keep this document as the
self-managed / escape-hatch reference and the definition of what "good" looks like.

Databases: `cnote` (authoring) and `cnote_live` (LIVE read database, CQRS). Back up **both**; the live DB is a projection of
authoring data (`docs/design/listing-versioning-and-live-db.md`), so its RPO may be looser, but restoring it is faster
than rebuilding.

## 1. What is backed up where

| Data | Method | Frequency | Retention | Location |
|---|---|---|---|---|
| Postgres physical base backup | pgBackRest full weekly + differential daily | see `infra/postgres/pgbackrest.conf` | 4 full, 14 differential | repo1 bucket ap-south-1 **and** repo2 bucket ap-south-2 |
| Postgres WAL (PITR) | `archive_command` continuous, `archive_timeout=60s` | continuous | 14 days | same repos |
| Postgres logical dump (portable safety net) | `pg_dump -Fc` | nightly | 30 days | India-region bucket, encrypted |
| Redis | AOF + replica; no restore needed (derived state) | continuous | n/a | region B replica |
| Object storage | versioned buckets + cross-region replication | continuous, SLA 15 min | 30 days noncurrent versions | ap-south-1 -> ap-south-2 |
| Secrets/config | secrets manager with cross-region replica; manifests in git | on change | n/a | India |

Encryption: pgBackRest `repoN-cipher-type=aes-256-cbc`, bucket KMS keys per region; keys and passphrases in the secrets manager,
not on the DB host. Backups contain personal data: they are under the same DPDP retention and erasure rules as the source
(a `DataErasureRequested` is honoured in live data immediately; backups age out by retention, which is the documented DPDP
position, see `docs/compliance/retention-schedule.md`).

## 2. Enable WAL archiving and take a base backup (self-managed)

```bash
# postgresql.conf (see infra/postgres/primary.conf)
wal_level = replica; archive_mode = on; archive_timeout = 60s
archive_command = 'pgbackrest --stanza=cnote archive-push %p'

pgbackrest --stanza=cnote stanza-create
pgbackrest --stanza=cnote check                       # proves archive + repo access end to end
pgbackrest --stanza=cnote --type=full backup
pgbackrest --stanza=cnote info                        # backup age -> DR_BACKUP_URL / DR_WAL_ARCHIVE_URL exporter
```

Plain PostgreSQL equivalent (tested in the drill): `pg_basebackup -D /backup/base -X none -c fast --manifest-checksums=sha256`
followed by `pg_verifybackup --no-parse-wal /backup/base`; the archive is a directory/bucket filled by `archive_command`.

## 3. Streaming replica in the second region

```bash
# on the replica host (empty PGDATA), replication user with REPLICATION privilege:
pg_basebackup -h db-primary.ap-south-1.internal -U replicator -D $PGDATA -R -X stream -C -S region_b
cat infra/postgres/standby.conf >> $PGDATA/postgresql.conf
pg_ctl -D $PGDATA start
```

`-R` writes `standby.signal` and `primary_conninfo`; `-C -S` creates the replication slot so the primary keeps the needed WAL.
Lag (feeds `DR_PG_LAG_URL`):

```sql
-- on the primary
select client_addr, state, extract(epoch from replay_lag) as replay_lag_s from pg_stat_replication;
-- on the replica
select extract(epoch from now() - pg_last_xact_replay_timestamp()) as lag_s;   -- only meaningful while writes are flowing
```

Guard rails: `max_slot_wal_keep_size` on the primary so a dead replica cannot fill the disk (a slot that is invalidated means
re-seed the replica with `pg_basebackup`). Ensure the replica keeps `hot_standby_feedback=on` for long read queries
(analytics), or point analytics at a separate replica.

## 4. Point-in-time recovery

Situation: a bad migration/DELETE at 14:07:30 UTC; you need the database as of 14:07:00 UTC.

```bash
# 1. Pick the target time just BEFORE the mistake (UTC) and a base backup older than it.
# 2. Restore into a NEW data directory / instance (never over the live one).
pgbackrest --stanza=cnote --delta --type=time "--target=2026-09-30 14:07:00+00" \
           --target-action=promote restore --pg1-path=/var/lib/postgresql/17/restore
pg_ctl -D /var/lib/postgresql/17/restore -o "-p 5433" start

# plain-Postgres equivalent (exactly what the drill runs):
cp -R /backup/base $PGDATA_RESTORE && chmod 700 $PGDATA_RESTORE
cat >> $PGDATA_RESTORE/postgresql.conf <<CONF
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-09-30 14:07:00+00'
recovery_target_action = 'promote'
CONF
touch $PGDATA_RESTORE/recovery.signal && pg_ctl -D $PGDATA_RESTORE start

# 3. Verify, then either repoint the platform (cutover) or copy the lost rows back with pg_dump -t / COPY.
psql -p 5433 -d cnote -c "select count(*) from listings"      # sanity
```

Notes learned from the drill: recovery stops at the first consistent point after the target; make sure the WAL up to the target
is archived (`select pg_switch_wal()` before you begin, and wait for `archive_timeout`); a replica is **not** a backup, it
replicates the `DROP` within milliseconds.

## 5. Logical backup/restore (single database, cross-version, portable)

```bash
pg_dump -h $HOST -U $USER -d cnote -Fc -f cnote-$(date -u +%Y%m%dT%H%M%SZ).dump   # consistent snapshot, no locks that block writers
createdb -h $HOST -U $USER cnote_restored
pg_restore -h $HOST -U $USER -d cnote_restored --no-owner --exit-on-error cnote-....dump
# extensions (pgvector) must exist first: psql -d cnote_restored -c 'create extension if not exists vector'
# after restore, the HNSW indexes and search_tsv column come from the migrations' raw SQL: run `pnpm db:check`; then `pnpm db:migrate`
```

The dump is the tool for "give me last Tuesday's table" and for major-version moves; it is slower to restore than PITR (hours for
large datasets), so it is the safety net, not the primary recovery path.

## 6. Failback with pg_rewind (old primary back as a replica)

```bash
pg_ctl -D $OLD_PRIMARY stop -m fast
pg_rewind --target-pgdata=$OLD_PRIMARY --source-server="host=db-b port=5432 user=replicator dbname=postgres"
# pg_rewind copies config files from the source: re-apply this node's own port/archive settings afterwards
touch $OLD_PRIMARY/standby.signal      # + primary_conninfo pointing at the new primary
pg_ctl -D $OLD_PRIMARY start
```

Requires `wal_log_hints=on` (or data checksums) from before the divergence. If `pg_rewind` refuses, re-seed with `pg_basebackup`.

## 7. Object storage

```bash
aws s3api put-bucket-versioning --bucket cnote-private-aps1 --versioning-configuration Status=Enabled   # both buckets
aws s3api put-bucket-replication --bucket cnote-private-aps1 --replication-configuration file://infra/storage/s3-replication.json
aws s3api head-object --bucket cnote-private-aps2 --key <a recent key>                                 # arrived?
aws s3api get-bucket-replication --bucket cnote-private-aps1
```

Application config is `MEDIA_DRIVER=s3`, `MEDIA_REGION`, `MEDIA_ENDPOINT` (per region overlay). Restoring an overwritten/deleted
object: list versions (`aws s3api list-object-versions`) and copy the previous version back. Cloudflare R2 offers neither
India pinning nor cross-region replication, so it is limited to public, non-personal media (`DATA_RESIDENCY_R2_ACK=true`).

## 8. Restore test (monthly, records `lastRestoreTestAt`)

1. Restore the latest full + WAL to an isolated instance in region B: `pgbackrest ... restore` as in section 4 (target: latest).
2. `pnpm db:migrate` against it (must report no pending migrations), `pnpm db:check`.
3. Run the smoke checks: row counts of `persons`, `businesses`, `listings`, `domain_events` within the expected drift of production; `select max(id), max(occurred_at) from domain_events` close to now minus RPO; pgvector query works (`select 1 from listings order by embedding <=> embedding limit 1`).
4. Time the whole thing (RTO evidence), destroy the instance, publish `{lastRestoreTestAt}` to the endpoint behind `DR_BACKUP_URL`.

## 9. Redis

Losing Redis loses cache, rate-limit counters, the session-revocation cache and stream entries that consumers have not yet
processed. Domain events are durable in Postgres (`domain_events`, the outbox), which is the source of truth: after a Redis loss
start empty and, for any module that must see events again, re-relay them by clearing `published_at` for the affected id range
(`update domain_events set published_at = null where id > $LAST_GOOD`) - handlers are idempotent (at-least-once, ADR-007), so
re-delivery is safe. Derived stores have their own rebuilds: analytics `pnpm --filter @cnote/analytics backfill --reset ...`,
search `pnpm --filter @cnote/search reindex`.
