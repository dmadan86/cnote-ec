# Portability: ports, adapters and cloud moves (ADR-036)

Goal: run on Cloudflare-first infrastructure today and move to AWS, Azure, GCP or self-hosted by changing **configuration and adapters only**. Data must stay in India regions (ADR-010) on every provider.

Status legend: **implemented** (code path exists and is selectable by env), **stub** (selectable, fails loudly, mapping documented in code), **planned** (design only, no code), **n/a** (no vendor coupling).
Some rows describe work landing in parallel; the lead reconciles final env names against the code.

## 1. Rules that keep it portable

1. **No vendor SDK outside an adapter.** Domain packages and apps import a port (interface) and receive an adapter from a factory chosen by env. Vendor SDKs appear only in `*/adapters` or the provider file (`media/s3.ts`, `domains/src/edge/*`, `search/index-port/opensearch.ts`, `email/providers.ts`).
2. **Config-only switching.** Every capability has one selector variable (`MEDIA_DRIVER`, `EDGE_PROVIDER`, `SEARCH_BACKEND`, `QUEUE_DRIVER`, `EMAIL_PROVIDER`, `FIELD_KMS`, `HUMAN_VERIFIER`, `GST_PROVIDER`). Selecting an unimplemented provider fails loudly at first use, never silently falls back.
3. **Wire protocols over vendor APIs.** Postgres wire protocol, Redis protocol (RESP), S3 API, SMTP, OTLP, OpenSearch REST. Avoid provider-only features on the data path (no Durable Objects, no DynamoDB, no Cosmos-only APIs).
4. **Containers everywhere.** Every workload is an OCI image (see `apps/*/Dockerfile`); orchestration is plain Kubernetes manifests (`deploy/k8s`) or any container runtime. No function-runtime code.
5. **Edge is optional and additive.** The apps set their own security headers, caching headers and redirects (`next.config.ts`, `@cnote/security`). The CDN only caches and shields; removing it changes performance, not behaviour.
6. **State is in three places only:** Postgres (authoring + live read DB), Redis (cache, rate limits, streams), object storage. Everything else is stateless and replaceable.
7. **Secrets by reference.** Runtime reads env; an external secret store populates env. Encryption keys are wrapped by a KMS adapter (`FIELD_KMS`) so keys can be re-wrapped on a move without re-encrypting data.
8. **Portability is tested:** MinIO in `docker-compose.yml` (profile `storage`) exercises the S3 adapter; OpenSearch (profile `search`) exercises the search adapter; CI has a job for the latter.

## 2. Adapter matrix

### 2.1 Data and messaging

| Capability | Env | Cloudflare (first choice) | AWS | Azure | GCP | Self-hosted | Status |
|---|---|---|---|---|---|---|---|
| **Postgres 17 + pgvector** (authoring DB `DATABASE_URL`, live read DB `LIVE_DATABASE_URL`) | `DATABASE_URL`, `LIVE_DATABASE_URL` | No managed Postgres in India. Use Hyperdrive only as a pooler in front of another provider's DB. Pair Cloudflare edge with a DB from another column | RDS or Aurora PostgreSQL 17 (pgvector supported, `CREATE EXTENSION vector`), region `ap-south-1` Mumbai / `ap-south-2` Hyderabad | Azure Database for PostgreSQL Flexible Server (pgvector via `azure.extensions`), Central India / South India | Cloud SQL or AlloyDB for PostgreSQL (pgvector supported), `asia-south1` Mumbai / `asia-south2` Delhi | `pgvector/pgvector:pg17` image, or CloudNativePG / Patroni | implemented (plain `pg` driver via `@prisma/adapter-pg`; only needs the `vector` extension and `pg_trgm`/FTS built-ins) |
| **Redis** (cache, rate limits, session revocation, event stream, job queue) | `REDIS_URL` | No managed Redis. Use another provider's; Upstash is HTTP/TLS Redis with Mumbai regions | ElastiCache for Redis / Valkey (in-transit TLS: `rediss://`) | Azure Cache for Redis | Memorystore for Redis | `redis:8-alpine`, Valkey | implemented (ioredis; Streams + consumer groups need Redis >= 5) |
| **Queue / event bus** | `QUEUE_DRIVER=redis\|kafka\|memory` | Redis Streams (default). Cloudflare Queues not used (vendor-only API) | Redis Streams, or MSK (Kafka) | Redis Streams, or Event Hubs (Kafka endpoint) | Redis Streams, or Managed Kafka | Redis Streams, or Redpanda/Kafka | redis implemented; memory (tests) implemented; kafka stub (`core/queue/kafka.ts`); transactional outbox is provider independent |
| **Search** | `SEARCH_BACKEND=postgres\|opensearch`, `OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` | Postgres FTS + pgvector (default) | Amazon OpenSearch Service | OpenSearch on AKS (Azure has no native OpenSearch) or Azure AI Search (would need a new adapter) | OpenSearch on GKE (or Vertex/Elastic, new adapter) | OpenSearch container | postgres implemented; opensearch implemented (landing, contract tests optional in CI); AI Search / Elastic planned |
| **Object storage** (private + public buckets) | `MEDIA_DRIVER=local\|r2\|s3\|azure\|gcs`, `MEDIA_BUCKET`, `MEDIA_PRIVATE_BUCKET`, `MEDIA_ENDPOINT`, `MEDIA_REGION`, `MEDIA_ACCESS_KEY_ID`, `MEDIA_SECRET_ACCESS_KEY`, `MEDIA_PUBLIC_BASE_URL` | R2 (S3 API, `MEDIA_DRIVER=r2`, region `auto`, zero egress) | S3 (`s3`, region `ap-south-1`) + CloudFront in front of the public bucket | Blob Storage + Front Door (`azure`) | Cloud Storage + Cloud CDN (`gcs`) | MinIO or Ceph RGW via the S3 driver (`s3` + `MEDIA_ENDPOINT`) | local, r2, s3 implemented (`media/s3.ts`); azure and gcs are stubs with mapping notes (`media/stubs.ts`). GCS also exposes an S3-interop API usable with `s3` |

### 2.2 Edge, security, identity-adjacent

| Capability | Env | Cloudflare | AWS | Azure | GCP | Self-hosted | Status |
|---|---|---|---|---|---|---|---|
| **CDN / edge + custom hostnames** (storefront domains) | `EDGE_PROVIDER=cloudflare\|aws\|vercel\|mock`, `CF_API_TOKEN`, `CF_ZONE_ID` (+ `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`), `STOREFRONT_ROOT_DOMAIN`, `STOREFRONT_CNAME_TARGET`, `STOREFRONT_APEX_IPS` | Cloudflare for SaaS custom hostnames | CloudFront (multi-tenant distributions) + ACM | Front Door custom domains + managed certs | Cloud CDN / Load Balancer + Certificate Manager | Caddy or Traefik with on-demand TLS (ACME) | cloudflare and vercel implemented, mock (dev); aws stub with design notes (`domains/src/edge/aws.ts`); azure, gcp, self-hosted planned |
| **WAF / bot protection** | `HUMAN_VERIFIER=turnstile\|hcaptcha\|recaptcha\|off`, `TURNSTILE_SECRET`, `HCAPTCHA_SECRET`, `RECAPTCHA_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Managed WAF, rate limiting, Bot Fight, Turnstile (rules in `deploy/cloudflare/README.md`) | AWS WAF + Shield; Turnstile still works (it is a standalone HTTPS verify) | Front Door WAF | Cloud Armor + reCAPTCHA Enterprise | ModSecurity/Coraza + CrowdSec; hCaptcha | verifier adapters implemented (`security/human.ts`); WAF rules are infrastructure (documented, not code) |
| **KMS / secrets** (field encryption keys, app secrets) | `FIELD_KMS=local\|aws\|azure\|gcp`, `FIELD_ENCRYPTION_KEYS`, `FIELD_ENCRYPTION_ACTIVE_KID`, `FIELD_KMS_KEY_ARN`, `BLIND_INDEX_KEY` | No KMS. Workers Secrets / Secrets Store for edge; keep DEKs wrapped by another KMS or `local` keyring | KMS + Secrets Manager (envelope wrap) | Key Vault | Cloud KMS + Secret Manager | HashiCorp Vault / OpenBao, or `local` keyring from sealed secrets | local keyring implemented (envelope: per-record DEK wrapped by KEK; `security/field-crypto.ts`); aws, azure, gcp KMS stubs with wrap/unwrap mapping |
| **Email (transactional)** | `EMAIL_PROVIDER=console\|smtp\|ses\|resend`, `EMAIL_FROM` | any SMTP; MailChannels not used | SES (`ap-south-1`) | Azure Communication Services Email or SMTP | SMTP relay (no native bulk mail) | Postfix / any SMTP | console implemented (dev); smtp, ses, resend are stubs (`email/providers.ts`) |
| **SMS + WhatsApp OTP** | planned: `OTP_CHANNEL_SMS_PROVIDER`, `OTP_CHANNEL_WA_PROVIDER` (names to be set by the auth work) | n/a (India DLT-registered aggregator required: MSG91, Exotel, Gupshup, Kaleyra, or WhatsApp Cloud API direct) | SNS SMS is not DLT friendly; use an aggregator | Aggregator | Aggregator | Aggregator | dev echo only (`OTP_DEV_ECHO`); provider adapters planned. Vendor choice is an ADR-010 open question |
| **GST / KYC provider** | `GST_PROVIDER=mock\|cashfree\|surepass`, `GST_PROVIDER_KEY`, `GST_PROVIDER_SECRET`, `GST_PROVIDER_BASE_URL`, `GST_PROVIDER_TIMEOUT_MS` | n/a (external API) | n/a | n/a | n/a | n/a | mock implemented; cashfree/surepass adapters landing |
| **AI models** | `AI_PROVIDER=heuristic\|anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL_FAST`, `AI_MODEL_REASONING`, `EMBEDDING_DIM` | any (redact PII first) | Bedrock (planned adapter) | Azure OpenAI (planned) | Vertex AI (planned) | local models (planned) | heuristic and anthropic implemented |

### 2.3 Observability and runtime

| Capability | Env | Options | Status |
|---|---|---|---|
| **Errors** | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Sentry SaaS (region choice) or self-hosted Sentry / GlitchTip (Sentry protocol). PII scrubbed in `@cnote/observability` before send | implemented (no-op without DSN) |
| **Analytics** | `NEXT_PUBLIC_CLARITY_PROJECT_ID` | Clarity after consent only; can be swapped for self-hosted analytics because it is a single consent-gated loader | implemented |
| **Logs / metrics / traces** | planned: `OTEL_EXPORTER_OTLP_ENDPOINT` | Any OTLP backend: Grafana Cloud/Tempo/Loki, CloudWatch via ADOT, Azure Monitor, Cloud Trace, self-hosted | planned (Sentry traces only today) |
| **Container runtime** | n/a | Cloudflare has no general container runtime yet: run images on any of: EKS/ECS Fargate (AWS), AKS/Container Apps (Azure), GKE/Cloud Run (GCP), k3s/Nomad (self-hosted). Manifests: `deploy/k8s` (Kustomize). Images: `apps/*/Dockerfile`, `deploy/docker/migrate.Dockerfile` | implemented (Dockerfiles, compose, Kustomize) |
| **Secrets in cluster** | n/a | External Secrets Operator, sealed-secrets, or CSI driver (AWS Secrets Manager / Key Vault / Secret Manager) producing the `cnote-secrets` Secret | manifests reference the Secret; operator is per-cloud setup |

## 3. Runbook: move from Cloudflare + X to AWS

Assume today: apps on X (containers), Postgres on X, Redis on X, R2 for media, Cloudflare in front, Cloudflare for SaaS for custom hostnames. Rehearse in a staging copy first; target a low-traffic window; keep the source stack read-only for 7 days as rollback.

**Prep (T minus 2 weeks)**
1. Create the AWS account structure, VPC (private subnets in `ap-south-1`), EKS or ECS, ECR, Secrets Manager, KMS keys (one CMK for field-encryption KEK, one for secrets).
2. Stand up managed Postgres (RDS/Aurora 17, `CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;`), ElastiCache (`rediss://`), and S3 buckets `cnote-public` and `cnote-private` (block public access on both; public reads only through CloudFront with Origin Access Control).
3. Build and push images to ECR from CI (same Dockerfiles). Apply `deploy/k8s/overlays/<aws>` (copy `prod`, patch image registry, ConfigMap values, ingress).
4. Populate `cnote-secrets` through External Secrets. Set the ConfigMap: `MEDIA_DRIVER=s3`, `MEDIA_ENDPOINT` unset, `MEDIA_REGION=ap-south-1`, real bucket names, `MEDIA_PUBLIC_BASE_URL=https://media.<domain>` (CloudFront alias).
5. Lower DNS TTLs to 60 s for `www`, `seller`, `admin`, `studio`, `api`, `media`, `sites`.

**Data migration**
6. **Postgres:** start logical replication for near-zero downtime (`pg_dump --schema-only` then publication/subscription, or AWS DMS with full load + CDC). Simple path with a maintenance window: stop the worker, set apps to read-only maintenance, `pg_dump -Fc` both databases (`cnote`, `cnote_live`), `pg_restore --no-owner` into RDS, then run `migrate` job to confirm no pending migrations. Verify row counts on hot tables, `SELECT count(*) FROM domain_events`, and pgvector index presence (HNSW indexes are created by raw SQL migrations: run the `db:check` guard and compare `\di`).
7. **Redis:** cache and rate limits are disposable. The event stream (`cnote:events`) and queues must be drained: stop the worker, wait for the outbox to empty (no unpublished rows), then start on the new Redis. Do not copy the stream.
8. **Object storage R2 to S3:** `rclone` with two remotes.
   ```
   rclone config   # remote "r2": type s3, provider Cloudflare, endpoint https://<acct>.r2.cloudflarestorage.com ; remote "s3": type s3, provider AWS, region ap-south-1
   rclone sync r2:cnote-private s3:cnote-private --checksum --transfers 32 --progress
   rclone sync r2:cnote-public  s3:cnote-public  --checksum --transfers 32 --progress
   rclone check r2:cnote-private s3:cnote-private --one-way
   ```
   Object keys are content-addressed and provider-neutral (`media/keys.ts`), so no database rewrite is needed. Run a final delta sync during cutover.
9. **Key re-wrapping:** field-encrypted columns use envelope encryption (per-record DEK wrapped by a KEK). Provision the AWS KMS CMK, then run a re-wrap script (write it if `security` does not yet ship one; it is a loop over encrypted rows): unwrap each DEK with the old KEK and wrap with the new (`FIELD_KMS=aws`, `FIELD_KMS_KEY_ARN=...`, keep the old keyring available as `FIELD_ENCRYPTION_KEYS` during the transition, new active kid via `FIELD_ENCRYPTION_ACTIVE_KID`). Ciphertext of the data itself does not change. Do not retire the old KEK until every row reports the new kid. Rotate `JWT_SECRET*` only if you accept logging everyone out.

**Cutover**
10. Smoke test the AWS stack with a hosts-file override: sign in per app, create an enquiry, upload an image, run `pnpm db:seed`-free checks, confirm the worker consumes.
11. Freeze writes (maintenance flag), final Postgres delta and `rclone sync`, start the worker on AWS, switch DNS (Cloudflare records to the AWS load balancer or CloudFront). If staying on Cloudflare for DNS/WAF/CDN, only change origins; if leaving, move the zone or replace with Route 53 + CloudFront + AWS WAF and re-create the rules from `deploy/cloudflare/README.md`.
12. **Custom hostnames:** set `EDGE_PROVIDER=aws` once the adapter is implemented (currently a stub); until then keep Cloudflare for SaaS as the edge for storefront domains, pointing its fallback origin at AWS. Sellers' CNAMEs do not change, which is the reason to keep this last.
13. Unfreeze, watch Sentry, queue depth and `/health`. Purge CDN caches.

**After**
14. Keep the old stack read-only 7 days, then export a final backup and decommission. Restore DNS TTLs. Update `docs/architecture/portability.md` statuses and record the move as a new ADR.

**Rollback:** until step 11 finishes, nothing changed for users. After it, point DNS back to the old origins; because writes on AWS after cutover would be lost, use logical replication in reverse or accept a maintenance window rollback within the first hour.

## 4. Runbook: move to Azure

Same shape as AWS; differences only.

1. **Foundation:** resource group in Central India (Pune) or South India (Chennai), AKS or Container Apps, ACR, Key Vault, Azure Cache for Redis, Azure Database for PostgreSQL Flexible Server 17 (allow-list `vector` and `pg_trgm` in the `azure.extensions` server parameter, then `CREATE EXTENSION`).
2. **Storage:** `MEDIA_DRIVER=azure` is a **stub**. Two options: (a) implement `AzureMediaStore` per the mapping in `media/stubs.ts` (`@azure/storage-blob`, containers for public/private, account name and key from `MEDIA_ACCESS_KEY_ID` / `MEDIA_SECRET_ACCESS_KEY`, Front Door for the public container), or (b) interim: run MinIO or an S3 gateway on AKS and use `MEDIA_DRIVER=s3`. Choose (a) for production. Copy data with `rclone` (remote type `azureblob`): `rclone sync r2:cnote-private azure:cnote-private`.
3. **Postgres:** same logical replication or `pg_dump`/`pg_restore` as AWS; Azure DMS supports online migration for PostgreSQL. Verify the HNSW indexes exist after restore.
4. **KMS re-wrap:** `FIELD_KMS=azure` is a stub; implement wrap/unwrap against a Key Vault key (`wrapKey`/`unwrapKey` operations with RSA-OAEP or AES-KW) using the same interface as the local keyring, then run the re-wrap script as in AWS step 9.
5. **Edge:** Azure Front Door Standard/Premium with WAF policy, custom domains with managed certificates; storefront custom hostnames need an `azure` edge adapter (planned) or keep Cloudflare for SaaS with an Azure origin.
6. **Email/SMS:** Azure Communication Services or SMTP; OTP aggregator unchanged.
7. **Secrets:** Key Vault CSI driver or External Secrets Operator populating `cnote-secrets`.
8. DNS cutover, freeze/unfreeze and rollback as in the AWS runbook (steps 10 to 14).

GCP follows the same pattern: Cloud SQL for PostgreSQL (`CREATE EXTENSION vector`), Memorystore, GCS via the S3-interoperability API with HMAC keys (`MEDIA_DRIVER=s3`, `MEDIA_ENDPOINT=https://storage.googleapis.com`) as a stopgap until the `gcs` driver is implemented, Cloud KMS for `FIELD_KMS=gcp` (stub).

## 5. Known gaps to close for real portability

| Gap | Impact | Suggested owner step |
|---|---|---|
| Azure and GCS media drivers, AWS/Azure/GCP KMS wrappers are stubs | Cannot leave S3-compatible storage or local keyring without new code | Implement mirroring `media/s3.ts` and the local KMS interface |
| Email providers (SMTP/SES/Resend) are stubs | No production email on any cloud | Implement SMTP first (works everywhere) |
| SMS/WhatsApp OTP providers not built | Phone login and lead capture blocked in production | Provider port + one aggregator |
| No OTLP export | Observability tied to Sentry | Add OpenTelemetry SDK behind `@cnote/observability` |
| Next `output: "standalone"` not enabled | Images are large, and cold starts slower | Follow-up: enable in each `next.config.ts` with `outputFileTracingRoot`, then switch Dockerfile runtime to copy `.next/standalone` |
| Data residency not enforced by config | Wrong-region resources possible | Add a `DATA_REGION` startup assertion and IaC policy |
