# syntax=docker/dockerfile:1.7
# @cnote/worker (Node). Build from the REPO ROOT:  docker build -f apps/worker/Dockerfile -t cnote-worker .
# Runtime choice: tsx (no compile step). Internal packages export TypeScript source (package.json "exports" -> ./src/*.ts,
# ADR-026), so a `tsc` build would need every package bundled first. tsx keeps dev and prod identical; cost is ~1s
# extra cold start and ~60 MB RAM. Follow-up: esbuild bundle per entrypoint (externals: @prisma/client, pg, ioredis, sharp).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.27.0 --activate
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM fetch AS deps
COPY . .
# -w keeps root devDependencies: tsx is the runtime. `postinstall` runs prisma generate (placeholder URL, no connection made).
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    LIVE_DATABASE_URL=postgres://build:build@localhost:5432/build_live \
    pnpm install --offline --frozen-lockfile -w --filter "@cnote/worker..."

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /repo /repo
RUN mkdir -p /data/media && chown node:node /data/media
USER node
WORKDIR /repo/apps/worker
# No HTTP port: liveness is the process itself (k8s restarts on exit). Runs the outbox relay, event handlers, queue consumers and cron.
CMD ["node", "--import", "tsx", "src/index.ts"]
