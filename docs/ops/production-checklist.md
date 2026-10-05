# Production checklist

Everything a production deployment must set or do. It is derived from `packages/security/src/secrets.ts` (`validateSecrets`, run at boot of every app and the worker), `.env.example` and the controls in `docs/security/security-architecture.md`. With `NODE_ENV=production` the process **refuses to start** on any item marked "boot check"; outside production the same checks only warn. Other runbooks: [deploy](deploy.md), [Cloudflare setup](../../deploy/cloudflare/README.md), [DR](dr-runbook.md), [DB roles](db-roles.md), [monitoring](monitoring.md).

Generate random values with `openssl rand -base64 32` (or `48` for JWT secrets). Store them in the secret manager and the runtime `cnote-secrets` (`deploy/k8s/base/secret.example.yaml` is the template), never in git.

## 1. Secrets and keys

| Item | Requirement | Boot check |
|---|---|---|
| `JWT_SECRET_WEB`, `JWT_SECRET_SELLER`, `JWT_SECRET_ADMIN` (or a master `JWT_SECRET`) | 32+ random characters, no placeholder text; low-entropy values are rejected. Each realm secret must differ from the others and from `JWT_SECRET`. Studio uses the seller realm. Setting only `JWT_SECRET` works but warns; set per-realm secrets. | yes |
| `FIELD_ENCRYPTION_KEYS` | `kid:base64key[,kid2:base64key]`, each key 32 bytes, valid unique key ids; `FIELD_ENCRYPTION_ACTIVE_KID` (if set) must be in the list. Required when `FIELD_KMS=local` (the default). Not needed by studio. | yes |
| `BLIND_INDEX_KEY` | base64, 32+ bytes. Not needed by studio. | yes |
| `REVALIDATE_SECRET` | secret shared by the cache worker and `POST /api/revalidate`. 32+ characters when set (a shorter value fails the boot check); unset disables purging, so set it. | yes (length) |
| `DOMAIN_CHECK_SECRET` | dedicated random secret for the custom-domain probe (HKDF-derived, never `JWT_SECRET`). Required when `EDGE_PROVIDER` is `cloudflare`, `vercel` or `aws`, or `DOMAINS_HTTP_PROBE=true`. | yes |
| `PREVIEW_TOKEN_SECRET`, `GRIEVANCE_VERIFY_SECRET` | optional; both fall back to a key derived from `JWT_SECRET`. Set dedicated values when you can. | no |
| Webhook secrets, one per ENABLED provider | `RAZORPAY_WEBHOOK_SECRET` (`PAYMENTS_PROVIDER=razorpay`), `CASHFREE_WEBHOOK_SECRET` (`=cashfree`), `ESCROW_WEBHOOK_SECRET` (`ESCROW_ENABLED=true`), `CREDIT_WEBHOOK_SECRET` (`CREDIT_ENABLED=true`), `KYC_WEBHOOK_SECRET` (`KYC_PROVIDER` set and not `mock`), `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` (WhatsApp Cloud enabled). There are no defaults: an unset secret means nothing verifies. Register each webhook URL with the provider (`{API_PUBLIC_URL}/webhooks/...`, see `.env.example`). | yes |
| Turnstile | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` on web and seller (`HCAPTCHA_SECRET` or `RECAPTCHA_SECRET` for those verifiers). `HUMAN_VERIFIER=off` disables bot protection explicitly. The site key is a build-time public variable. | yes |
| Attachment malware scanner | web and seller refuse to start while RFQ/quote uploads are on (`RFQ_ATTACHMENTS_ENABLED`, default on) unless `ATTACHMENT_SCANNER=clamav` with `CLAMAV_HOST` (clamd TCP, `CLAMAV_PORT` 3310). Alternatives: `RFQ_ATTACHMENTS_ENABLED=false`, or the explicit, logged waiver `ATTACHMENT_SCAN_WAIVER=1` (uploads are then NOT virus-scanned; the mock scanner only catches the EICAR test file). See `docs/design/attachment-scanning.md`. | yes |
| Provider credentials | `ANTHROPIC_API_KEY` if `AI_PROVIDER=anthropic` (on ai-service only once callers run `AI_TRANSPORT=http`), payment gateway, GST/KYC, media, email and Google OAuth keys as used. | no |

## 2. Dev conveniences that must be off

- **No `OTP_DEV_ECHO`.** `OTP_DEV_ECHO=true` returns one-time codes in API responses and fails the boot check. `ALLOW_OTP_ECHO_IN_PRODUCTION=1` downgrades it to a warning and exists only for the e2e servers and the dev k8s overlay; never set it on a real deployment. Configure a real OTP sender (`OTP_SENDER`); a real sender never echoes.
- No mock partners: set `PAYMENTS_PROVIDER`, `ESCROW_PARTNER`, `CREDIT_PARTNER` and `KYC_PROVIDER` to real providers (or leave the feature off). Do not set `PAYMENTS_ALLOW_MOCK_IN_PRODUCTION`, `ESCROW_MOCK_CHECKOUT` or `CREDIT_MOCK_CHECKOUT`. `GST_PROVIDER` defaults to `mock`; select `cashfree` or `surepass`. GSTIN proof of control (`gst/control.ts`) refuses to run in production until a real provider is wired in.
- Do not set `MFA_ADMIN_OPTIONAL` (ignored in production, dev only). Admin MFA is mandatory.
- `STOREFRONT_EMBEDS_ENABLED` stays off until embedded content is moderated (turning it on needs a web rebuild and re-asks cookie consent, ADR-041).

## 3. Network, proxy and TLS

- **Cloudflare in front, origin locked.** Proxy every app hostname; restrict the origin (load balancer or ingress) to Cloudflare IP ranges, Authenticated Origin Pulls or a Cloudflare Tunnel. Otherwise a client can send its own `cf-connecting-ip`. Put admin behind Cloudflare Access. Full list: `docs/security/security-architecture.md` section 7 and `deploy/cloudflare/README.md`.
- **`TRUST_CLOUDFLARE=1`** on every app and the worker deployed behind Cloudflare. Without it `cf-connecting-ip` is ignored and per-IP rate limits lose the real client address.
- **`TRUSTED_PROXY_HOPS`**: the number of proxies you run in front of the apps (default 1; for example 2 for an ALB plus an NGINX ingress). A shorter `X-Forwarded-For` chain yields its rightmost entry, never the first.
- **Database TLS.** `DATABASE_URL` and `LIVE_DATABASE_URL` need `?sslmode=require` (or `verify-ca` / `verify-full`) unless the host is loopback. A private network may waive it with `DB_TLS_OPTIONAL=1`; write down why. There is no localhost fallback in production: a missing URL fails.
- **Redis TLS.** `REDIS_URL` must be `rediss://` unless loopback; waiver `REDIS_TLS_OPTIONAL=1` for a documented private network. Dev compose Redis uses a password; production needs its own credentials in the URL.
- Hosts, buckets, replicas and telemetry stay in India regions (ADR-010); set `DATA_RESIDENCY_ENFORCE=true` and `DATA_RESIDENCY_DB_HOST_ALLOW` per region (deploy.md section 2).

## 4. Legal entity and public pages

The buyer web **refuses to start** unless all of these are set (`LEGAL_ENTITY_STRICT=false` opts out, for preview deploys and local production builds only; it then logs an error): `PLATFORM_LEGAL_NAME`, `PLATFORM_CIN`, `PLATFORM_GSTIN`, `PLATFORM_ADDRESS`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `SUPPORT_WHATSAPP`, `SUPPORT_HOURS` (Consumer Protection (E-Commerce) Rules 2020; rendered in the footer and on `/contact`).

Also set `GRIEVANCE_OFFICER_NAME` and `GRIEVANCE_OFFICER_EMAIL` (shown on the grievance page), `SECURITY_CONTACT_EMAIL` (`/.well-known/security.txt`; the policy URL is `APP_URL` plus `/security`), and for invoicing `PLATFORM_STATE_CODE`, `PLATFORM_SAC` and `PLATFORM_GST_RATE_BPS`. The public origins `APP_URL`, `SELLER_APP_URL`, `ADMIN_APP_URL`, `STUDIO_APP_URL`, `API_PUBLIC_URL` and `API_CORS_ORIGINS` must be the real hosts.

## 5. Content Security Policy

The CSP is enforced by default. `CSP_REPORT_ONLY=1` (observe without enforcing) fails the boot check unless `CSP_REPORT_ONLY_ACK=1` acknowledges it, which turns the error into a warning. Use it only for a time-boxed rollout: run a week with it, review the `csp.violation` events from `/api/csp-report`, then remove both variables. Static pages still rely on `unsafe-inline` (hash-based CSP is not feasible on Next 16; see the security doc).

## 6. Processes

- **Run the worker**, exactly one active per region (outbox relay, schedulers, queue consumers). It is required: password-reset, "someone tried to register with your email" and DPDP confirmation emails go through the `identity.mail` queue and are not sent without it. The standby region keeps it scaled to zero (deploy.md section 4). Use `QUEUE_DRIVER=redis`.
- Run migrations with the migrate job (`prisma migrate deploy`) before rolling the apps; the live read DB has its own (`pnpm --filter @cnote/live-db migrate:deploy`).
- Staging and test databases created before the append-only trigger migration (`20261003000000_append_only_triggers`): re-run `pnpm db:test:prepare` for test databases.
- Set the Sentry DSNs (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`) and wire the alerts and dashboards from `docs/ops/monitoring.md`.

## 7. Database role (recommended before real money or consent evidence)

The append-only triggers guard against mistakes and ad-hoc SQL, but `cnote.allow_purge` is an ordinary session setting. Run the apps as a non-owner, non-superuser role (`cnote_app`) and migrations as `cnote_owner`, with the column grants in [db-roles.md](db-roles.md). Retention purges on protected tables run through `withPurge()`.

## 8. GitHub and CI

- Create the **`ai-evals` environment** (Settings, Environments): add required reviewers, optionally restrict deployment branches to `main`, and store `ANTHROPIC_API_KEY` as an **environment secret** (a key with a low spend cap); delete any repository-level copy. A file cannot do this. Until it exists the live eval job runs without the review gate.
- Commit `packages/ai/evals/baseline/anthropic.json` from a real run (`pnpm --filter @cnote/ai run eval --provider anthropic --update-baseline`). Until then a PR that changes a prompt or model id cannot pass the live check (`docs/guides/ai-evals.md`).
- Make the `e2e` job a required status check when the team is ready (`docs/guides/testing.md`).
- Actions are pinned by SHA and base images by digest; keep Dependabot enabled.

## 9. Open supply-chain TODO

MinIO stopped publishing community images to Docker Hub and Quay, so `minio/minio` and `minio/mc` in `docker-compose.yml` use release tags with a `TODO(supply-chain)` instead of digests. Mirror them to an India-region registry and pin by digest (`docker buildx imagetools inspect <image:tag>`). They are dev and test storage only; production uses R2 or S3. `infra/docker/Dockerfile.deploy` has not been validated against a Docker daemon (deploy.md section 1).

## 10. Final smoke test

1. Start each app and the worker with production env on a staging stack; confirm none exits with "Refusing to start".
2. Sign up, request a password reset and confirm the email arrives (proves the worker and the mail queue).
3. Confirm `/.well-known/security.txt`, the footer legal details and the cookie banner render, and that no non-necessary cookie is set before consent.
4. From outside Cloudflare, confirm the origin refuses direct requests.
5. Send a webhook with a bad signature to each enabled provider endpoint and confirm it is rejected.
