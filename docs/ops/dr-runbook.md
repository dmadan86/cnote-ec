# Disaster recovery runbook: second India region (ADR-023)

Scope: loss of the primary region (Mumbai, `ap-south-1`) or of its data stores. Standby: Hyderabad `ap-south-2` (or the same
pair on another cloud: Azure Central India / South India, GCP `asia-south1` / `asia-south2`). Both regions are in India; **no
data, backup, replica or log leaves India** (ADR-010). The residency guard stays on in both regions.

Companion docs: `backup-restore.md` (commands, tested), `deploy.md` (manifests), `docs/design/scale.md` (design).
Verify posture any time: `pnpm ops:dr-check` (section 7).

## 1. Targets

| Layer | RPO (max data loss) | RTO (time to serve again) | Mechanism |
|---|---|---|---|
| PostgreSQL (authoring + live read DB) | <= 60 s regional loss; <= 1 min to any second for logical mistakes (PITR) | <= 30 min regional; <= 60 min PITR | async streaming replica in region B + WAL archive to two India buckets |
| Redis | 5 min (irrelevant to correctness) | 15 min | replica; everything in it is derivable (cache, rate limits, session-revocation set; the event stream is re-filled from the Postgres outbox) |
| Object storage (listing images, KYC, voice) | <= 15 min (replication SLA) | 0 (bucket already exists) | S3-compatible cross-region replication, both India regions |
| Stateless tiers (web, seller, admin, api, ai-service, search-service) | none | <= 15 min | warm standby, scale from minimum |
| Worker (relay, schedulers, analytics) | none (outbox is durable) | <= 30 min | started only in the active region |

Overall regional failover objective: **RPO <= 60 s, RTO <= 30 min.** The Postgres replica is deliberately asynchronous: a
synchronous replica in another city would stall every write when region B is unreachable.

Why the small RPO still holds for the business data that matters: every state change and its domain event commit in one
transaction (outbox, ADR-007). After promotion the worker republishes any outbox row with `published_at IS NULL`; handlers are
idempotent (at-least-once). Analytics projections resume from their checkpoints.

## 2. Topology

```
                 DNS (TTL 60s, health-checked /ready)
                          |
            +-------------+--------------+
            v                            v
  Region A ap-south-1 (ACTIVE)      Region B ap-south-2 (STANDBY, warm)
  web seller admin api              web seller admin api          (min replicas)
  ai-service search-service         ai-service search-service     (1 replica each)
  worker (relay+jobs)               worker  = 0 replicas
  Postgres PRIMARY  ---WAL stream-> Postgres REPLICA (read-only)
       |  archive-push                  ^ archive-get (catch-up)
       +--> bucket A (pgBackRest repo1) + bucket B (repo2)     [both India]
  Redis PRIMARY  ----------------> Redis REPLICA
  Private bucket A ---CRR (<=15m)-> Private bucket B
```

Config lives in `infra/`: `k8s/overlays/region-a-mumbai`, `region-b-hyderabad-standby`, `region-b-hyderabad-active`,
`postgres/*.conf`, `storage/s3-replication.json`, `dns/route53-failover.json`, `compose/docker-compose.prod.yml`.

## 3. Monitoring and alerts (page on-call)

| Signal | Alert | Source |
|---|---|---|
| Replica replay lag | > 30 s warn, > 60 s page | `pg_stat_replication.replay_lag` / cloud metric |
| WAL archive age | last archived segment older than 5 min | pgBackRest `info` / `pg_stat_archiver` |
| Base backup age | > 26 h | pgBackRest `info` |
| Restore drill age | > 35 days (ticket, not page) | drill log |
| Object replication backlog | oldest pending > 15 min | S3 replication metrics |
| Region B readiness | `/ready` != 200 | synthetic check |
| `heuristic-fallback` share of AI decisions | > 5% for 15 min | `ai_decisions.provider` |
| Outbox backlog | oldest `published_at IS NULL` row > 5 min | `domain_events` |

`pnpm ops:dr-check --strict` covers the first six and runs on a schedule (cron / CI every 15 minutes) with the `DR_*` endpoints:

| Env | Meaning |
|---|---|
| `DR_PG_LAG_URL` | JSON `{ "lagSeconds": n }` |
| `DR_WAL_ARCHIVE_URL` | JSON `{ "lastArchivedAt": ISO }` |
| `DR_BACKUP_URL` | JSON `{ "lastFullBackupAt": ISO, "lastRestoreTestAt": ISO }` |
| `DR_REDIS_LAG_URL` | JSON `{ "lagSeconds": n }` |
| `DR_MEDIA_REPLICATION_URL` | JSON `{ "oldestPendingSeconds": n }` |
| `DR_SECONDARY_HEALTH_URL` | region B `/ready` (2xx) |
| `DR_PRIMARY_REGION`, `DR_SECONDARY_REGION` | must be two different India regions |
| `DR_SECONDARY_DATABASE_URL` / `_LIVE_DATABASE_URL` / `_REDIS_URL` / `_MEDIA_REGION` / `_MEDIA_ENDPOINT` | region B stores, run through the residency guard |
| `DR_CHECK_TOKEN` | bearer token for the monitoring proxy |
| `DR_PG_LAG_WARN_SECONDS`, `DR_PG_LAG_FAIL_SECONDS`, `DR_WAL_MAX_AGE_SECONDS`, `DR_FULL_BACKUP_MAX_AGE_HOURS`, `DR_RESTORE_TEST_MAX_AGE_DAYS`, `DR_REDIS_LAG_FAIL_SECONDS`, `DR_MEDIA_BACKLOG_FAIL_SECONDS` | threshold overrides |

## 4. Decision: fail over or not

Declare a regional disaster (incident commander decides; two people confirm) when region A is unreachable for 10 minutes and
cloud status confirms a regional event, or the primary database is unrecoverable within the RTO. Do **not** fail over for a
bad deploy (roll back), an application bug, or a destructive query: those are PITR (section 6) or rollback, because streaming
replication faithfully replicates mistakes (proved in `infra/postgres/dr-drill.sh`).

## 5. Failover procedure (region A lost -> region B active) target 30 min

Roles: incident commander (IC), database operator, platform operator. Record timestamps (T+min) in the incident doc.

1. **T+0 Freeze.** IC announces the incident. Stop writers if region A is partially alive: `kubectl -n cnote scale deploy/cnote-worker --replicas=0` in A (skip if A is unreachable). Put the status page to "degraded".
2. **T+3 Check what we lose.** In B: `psql "$REPLICA_URL" -Atc "select now() - pg_last_xact_replay_timestamp()"` = the data-loss window (target < 60 s). Note the last replayed LSN (`select pg_last_wal_replay_lsn()`).
3. **T+5 Fence the old primary.** Ensure region A cannot accept writes if it returns: revoke its DB security-group ingress, or stop the instance. This prevents split brain.
4. **T+7 Promote Postgres in B.** Managed: use the provider's "promote read replica". Self-managed: `pg_ctl -D $PGDATA promote` (or `SELECT pg_promote();`). Verify: `select pg_is_in_recovery();` returns `f`; write and read a row. The live read DB (`cnote_live`) is promoted the same way.
5. **T+10 Promote Redis** `redis-cli -h redis-b REPLICAOF NO ONE`. (If Redis loss is complete, start empty: it holds derived state only.)
6. **T+12 Point the platform at B.** Update the database/redis secrets in region B (`cnote-secrets`: `DATABASE_URL`, `LIVE_DATABASE_URL`, `REDIS_URL` -> promoted primaries) and set the config overlay. Apply: `kubectl apply -k infra/k8s/overlays/region-b-hyderabad-active`. This scales web/api/ai-service/search-service to production size, unsuspends the migrate job and starts the **only** worker.
7. **T+15 Confirm.** `kubectl -n cnote rollout status deploy/cnote-api deploy/cnote-web`; `curl -fsS https://api-b.example.in/ready`. Check the worker log: `[worker] starting ...`, outbox draining (`select count(*) from domain_events where published_at is null;` falls to 0), analytics catching up (`pnpm --filter @cnote/analytics backfill --status`).
8. **T+18 Move traffic.** DNS: if health-checked failover is configured (`infra/dns/route53-failover.json`) it flips on its own once region A's `/ready` fails; otherwise update the records (TTL 60 s, so <= 2 min to propagate). Verify from outside: `dig +short api.example.in`, then a synthetic sign-in and search.
9. **T+25 Replication of the new topology.** Object storage: writes now land in bucket B; reverse the replication rule (B -> A) once A is back (`infra/storage/s3-replication.json` with buckets swapped). Start a new backup chain from B: `pgbackrest --stanza=cnote --type=full backup` (region B's repo1 becomes the local one).
10. **T+30 Communicate** (status page, customers if the RPO window affected data: DPDP incident duties apply if personal data was lost or exposed: follow `docs/compliance/breach-response-runbook.md`). Open the post-incident review.

Checks after failover: `pnpm ops:dr-check` with the roles swapped (`DR_PRIMARY_REGION=ap-south-2 DR_SECONDARY_REGION=ap-south-1`).

## 6. Point-in-time recovery (mistake, corruption, ransomware in region A)

Not a failover: restore a copy, extract or swap. Commands, tested end to end, in `backup-restore.md` section 4. Target RTO 60 min.
Decide: recover into a **new** instance to the timestamp just before the bad change, validate, then either cut over (planned
switch, minutes of write freeze) or copy the missing rows back.

## 7. Failback (region B active -> region A primary again) planned, off-peak

1. Repair region A: new/empty Postgres + Redis + buckets in `ap-south-1`.
2. **Rebuild A as a replica of B**: `pg_basebackup -h db-b -D $PGDATA -R -X stream -C -S region_a` (or `pg_rewind` if A's old primary is intact and `wal_log_hints`/checksums were on; tested in `dr-drill.sh` step 6). Wait until lag < 5 s. Reverse Redis and object replication likewise.
3. **Window (~5 min).** Scale worker in B to 0; scale writers in B to read-only maintenance page (or scale them to 0); wait for lag 0; promote A; point `DATABASE_URL`/`REDIS_URL` back; `kubectl apply -k infra/k8s/overlays/region-a-mumbai` (worker starts in A); `kubectl apply -k infra/k8s/overlays/region-b-hyderabad-standby` (worker off in B).
4. DNS back to A, verify, rebuild B as replica of A (repeat step 2 with roles swapped), run `pnpm ops:dr-check --strict`.

## 8. Drills (a runbook that has not been run does not exist)

| Drill | Frequency | Pass criteria | Record |
|---|---|---|---|
| Automated mechanics on scratch clusters: `bash infra/postgres/dr-drill.sh` (WAL archive, base backup, replica, PITR, promote, pg_rewind failback, dump/restore) | every CI-nightly / before any Postgres upgrade | prints `DR DRILL PASSED` | CI log |
| Backup restore test into an empty instance, run the app's smoke tests against it | monthly | restore < 60 min, row counts + `prisma migrate status` clean | drill log, updates `lastRestoreTestAt` |
| Game day: full failover of a **staging** pair, region B active for a day, failback | quarterly | RTO <= 30 min, RPO <= 60 s measured, no residency violation | post-mortem doc |
| Production failover rehearsal in a low-traffic window | yearly (after two clean staging game days) | as above | change record |

## 9. Data-residency checklist (each drill and each failover)

- [ ] `DATA_RESIDENCY_ENFORCE=true` in region A and B config (`pnpm ops:dr-check` fails otherwise).
- [ ] Region B stores match `DATA_RESIDENCY_DB_HOST_ALLOW`; no store outside `ap-south-1`/`ap-south-2` (or another Indian pair).
- [ ] Both backup repositories, the replication destination bucket and KMS keys are India-region.
- [ ] Monitoring/log shipping for both regions stays in India; the drill log contains no personal data.
- [ ] AI vendor calls still carry redacted text only (ai-service in region B uses the same egress rules).
