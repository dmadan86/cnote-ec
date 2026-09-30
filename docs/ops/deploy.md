# Deployment: images, manifests, two-region topology

Everything stays in India regions (ADR-010). Existing single-region manifests live in `deploy/` (docker compose, k8s base, Cloudflare
notes); the scale/DR work adds `infra/` and composes with it rather than replacing it.

## 1. Images

| Service | Dockerfile | Port | Notes |
|---|---|---|---|
| web, seller, admin | `apps/{web,seller,admin}/Dockerfile` | 3000, 3002, 3001 | multi-stage (pnpm fetch -> install/build -> runtime), non-root `node`, `next start` |
| api, worker | `apps/{api,worker}/Dockerfile` | 3003, none | tsx runtime (internal packages export TypeScript source, ADR-026), non-root, PID 1 = node |
| ai-service | `apps/ai-service/Dockerfile` | 3005 | same recipe as api |
| search-service | `apps/search-service/Dockerfile` | 3006 | same recipe as api |
| any Node service, slim variant | `infra/docker/Dockerfile.deploy` (`pnpm deploy`) | build args `PKG`, `APP_DIR`, `PORT` | production closure only. **Not yet validated** (authored without a Docker daemon); the per-app Dockerfiles are the CI-built ones |

All build from the repo root: `docker build -f apps/ai-service/Dockerfile -t cnote-ai-service .`. CI builds each Dockerfile on pull
requests that touch Docker inputs (matrix in `.github/workflows/ci.yml`, now including ai-service and search-service).
Push to an India-region registry (ECR `ap-south-1` with replication to `ap-south-2`, or equivalent) and deploy by digest.

Security baseline for every workload: non-root user, `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp
`RuntimeDefault`, read-only root filesystem where the runtime allows (ai-service), resource requests/limits, PodDisruptionBudget,
readiness on `/ready` (services) or `/health`, and a NetworkPolicy for the two new services.

## 2. Kubernetes (kustomize)

```
deploy/k8s/base                  existing: web seller admin studio api worker migrate + config
infra/k8s/base                   new: ai-service (Deployment, Service, HPA 2..20, PDB), search-service (HPA 2..12, PDB), NetworkPolicies
infra/k8s/overlays/
  region-a-mumbai                PRIMARY   ap-south-1: everything on, worker on
  region-b-hyderabad-standby     STANDBY   ap-south-2: minimum replicas, worker OFF, migrate job suspended
  region-b-hyderabad-active      FAILOVER  ap-south-2: production size, worker ON
```

Render or apply (each region is its own cluster with its own secrets):

```bash
kubectl kustomize infra/k8s/overlays/region-a-mumbai | less        # all three overlays render (verified)
kubectl --context prod-aps1 apply -k infra/k8s/overlays/region-a-mumbai
kubectl --context prod-aps2 apply -k infra/k8s/overlays/region-b-hyderabad-standby
# failover:  kubectl --context prod-aps2 apply -k infra/k8s/overlays/region-b-hyderabad-active
```

Secrets (`cnote-secrets`, created per cluster by your secret manager / external-secrets; never in git): existing keys plus

| Key | Consumers |
|---|---|
| `AI_SERVICE_TOKEN_SECRET` | ai-service (verify) and every caller (sign); comma list `new,old` to rotate |
| `SEARCH_SERVICE_TOKEN_SECRET` | search-service and callers |
| `ANTHROPIC_API_KEY`, `SARVAM_API_KEY` | **ai-service only** once callers run `AI_TRANSPORT=http` |
| `DATABASE_URL` | search-service should point at a **read replica** in its region |

HPA for ai-service (`infra/k8s/base/ai-service.yaml`): CPU 60% and memory 80% targets, 2..20 replicas, scale up +100% or +4 pods per
30 s, scale down max 25% per minute after a 5 minute stabilisation, `terminationGracePeriodSeconds: 40` so in-flight vendor calls
finish. Add a custom metric (in-flight requests) once a metrics adapter is available; the commented `Pods` metric is the template.

Region-specific config comes from the overlay's ConfigMap patch: `CNOTE_REGION`, `DR_*`, `DATA_RESIDENCY_ENFORCE=true`,
`DATA_RESIDENCY_DB_HOST_ALLOW` (regex for the India DB/cache hosts), `MEDIA_DRIVER=s3` with the region's `MEDIA_REGION`/`MEDIA_ENDPOINT`,
and the transport switches `AI_TRANSPORT=http`, `SEARCH_TRANSPORT=http` with the fallbacks on. Adjust the host regex to your cloud.

## 3. Docker hosts (no Kubernetes)

`infra/compose/docker-compose.prod.yml` runs the app tier of ONE region per host group, selected by profile:

```bash
# Region A (active)
REGISTRY=registry.ap-south-1.example.in TAG=<digest-or-tag> docker compose -f infra/compose/docker-compose.prod.yml \
  --env-file /etc/cnote/region-a.env --profile primary up -d
# Region B (standby)
... --env-file /etc/cnote/region-b.env --profile standby up -d
# Failover: promote databases (dr-runbook.md step 4-6), then start the single worker in B
... --env-file /etc/cnote/region-b.env --profile active up -d worker
```

State (Postgres, Redis, buckets) is external and reached through the env files. Terminate TLS in front (regional load balancer, Caddy,
or Cloudflare proxying only India-hosted origins). Validate a file with `docker compose -f infra/compose/docker-compose.prod.yml --profile primary config`.

## 4. Two-region topology rules

1. **Active/passive.** Exactly one region runs the worker (outbox relay, schedulers, analytics projections, queue consumers). The standby overlay scales it to zero; `active` starts it.
2. **One writer database.** Region B's Postgres is a read-only streaming replica until promoted. Migrations run only against the writer (`cnote-migrate` job is suspended in standby).
3. **Read-only paths in standby.** Standby web/api can serve static/cached content but writes fail while the DB is read-only; DNS keeps all traffic on region A until failover.
4. **Data never leaves India.** Both regions are India regions; backups, replicas, buckets and KMS keys likewise. `DATA_RESIDENCY_ENFORCE=true` in both; `pnpm ops:dr-check` verifies the pair.
5. **Services follow their callers.** ai-service and search-service run in each region and are addressed by in-cluster DNS (`http://cnote-ai-service`), so a region never depends on a cross-region call at request time.

## 5. Local runbook for the new services

```bash
# 1. shared secret and transport (root .env.local)
AI_SERVICE_TOKEN_SECRET=dev-ai-service-secret-0123456789abcdef
SEARCH_SERVICE_TOKEN_SECRET=dev-search-service-secret-0123456789abcdef
# 2. start the services
pnpm --filter @cnote/ai-service dev          # :3005   (GET /ready, /openapi.json)
pnpm --filter @cnote/search-service dev      # :3006
# 3. point callers at them (web/api/worker env)
AI_TRANSPORT=http AI_SERVICE_URL=http://localhost:3005
SEARCH_TRANSPORT=http SEARCH_SERVICE_URL=http://localhost:3006
# analytics: runs inside the worker once registered; manual:
pnpm --filter @cnote/analytics backfill --status
pnpm --filter @cnote/analytics backfill                    # drain to head
pnpm --filter @cnote/analytics backfill --reset funnel     # rebuild from event 0
```

## 6. Release checklist for service changes

1. Contract change? Regenerate the OpenAPI files (`pnpm --filter @cnote/ai-service openapi`, `... search-service openapi`) and commit them; add optional fields only, or a new `/v2` path.
2. `pnpm --filter @cnote/ai-service test` (contract suite) and `pnpm --filter @cnote/search-service test`.
3. Canary per `docs/design/scale.md` section 5; watch breaker-open and `heuristic-fallback` rates.
4. Rotate service token secrets with the `new,old` list: deploy services first (accept both), then callers (sign with new), then drop `old`.
