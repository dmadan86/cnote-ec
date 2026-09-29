# ADR-036: Cloudflare-first, cloud-portable ports and adapters

**Status:** Accepted
**Note:** Detail and runbooks: `docs/architecture/portability.md`. Complements ADR-006's India-region Kubernetes assumption.

**Context.** Cloudflare gives cheap edge, R2 with zero egress, Turnstile and custom-hostname SSL, which suit an early-stage marketplace. But lock-in to any one vendor is a strategic and residency risk, and India regions and enterprise buyers may require AWS or Azure later.

**Options.**
1. Go all-in on Cloudflare Workers, D1, Queues.
2. Go all-in on one hyperscaler.
3. Ports and adapters: use Cloudflare where best, but only behind interfaces selected by env; run compute in containers.

**Decision.** Option 3. Each capability has a port and a factory: storage `MEDIA_DRIVER=local|r2|s3|azure|gcs`; edge and custom hostnames `EDGE_PROVIDER`; search `SEARCH_BACKEND`; queue `QUEUE_DRIVER`; email `EMAIL_PROVIDER`; KMS/secrets `FIELD_KMS=local|aws|azure|gcp`; bot check `HUMAN_VERIFIER`; GST `GST_PROVIDER`. Rules: no vendor SDK outside an adapter, wire protocols over vendor APIs (Postgres, Redis, S3, SMTP, OTLP), containers only, edge is additive. Unimplemented providers are explicit stubs that fail loudly. Postgres and Redis run as managed services in an India region on a provider that offers them; Cloudflare sits in front for CDN, WAF and R2.

**Rationale.**
- A cloud move is a config change plus data copy (rclone, DB replication, KMS re-wrap), rehearsed in a runbook.
- Vendor negotiating leverage and residency flexibility.
- Local parity: MinIO and OpenSearch run in docker-compose.

**Consequences.**
- Adapter code and stubs to maintain; lowest-common-denominator features on the data path.
- Some adapters (Azure/GCS media, KMS wrappers, AWS edge, SMTP/SES) are not implemented yet.
- Split-vendor latency: Cloudflare edge to a DB in another cloud needs pooling and caching.

**Review.** Rehearse the AWS runbook once in staging by end of Phase 1; review the adapter matrix each quarter.
