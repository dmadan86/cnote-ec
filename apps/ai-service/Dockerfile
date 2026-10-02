# syntax=docker/dockerfile:1.7
# @cnote/ai-service (Node, Hono). Build from the REPO ROOT:  docker build -f apps/ai-service/Dockerfile -t cnote-ai-service .
# Same recipe as apps/api/Dockerfile (tsx runtime: internal packages export TypeScript source, ADR-026). Stateless and
# horizontally scalable; runs as the unprivileged "node" user with PID 1 = node so SIGTERM drains in-flight requests.
# A slimmer 'pnpm deploy' variant lives in infra/docker/Dockerfile.deploy.

# Pinned by digest (supply chain). Refresh: docker buildx imagetools inspect node:22-bookworm-slim, or let Dependabot (docker) do it.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM fetch AS deps
COPY . .
# -w keeps root devDependencies: tsx is the runtime. `postinstall` runs prisma generate (placeholder URL, no connection made).
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    LIVE_DATABASE_URL=postgres://build:build@localhost:5432/build_live \
    pnpm install --offline --frozen-lockfile -w --filter "@cnote/ai-service..."

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/ai-service
ENV PORT=3005
EXPOSE 3005
# /health = liveness (process is up); /ready = readiness (configuration + dependencies), used by the orchestrator's probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
