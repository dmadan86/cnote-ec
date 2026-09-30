# syntax=docker/dockerfile:1.7
# One-shot migration job image. Build from the REPO ROOT:  docker build -f deploy/docker/migrate.Dockerfile -t cnote-migrate .
# Runs `prisma migrate deploy` for the authoring DB (DATABASE_URL) and, when LIVE_DATABASE_URL is set, for the live read DB
# (packages/live-db). Never runs `migrate dev`. Run as a k8s Job / compose `migrate` service / CI release step BEFORE
# rolling out apps. Migrations are additive-first (expand/contract) so old app versions keep working during rollout.

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
 && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM fetch AS deps
COPY . .
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    LIVE_DATABASE_URL=postgres://build:build@localhost:5432/build_live \
    pnpm install --offline --frozen-lockfile -w --filter "@cnote/db..." --filter "@cnote/live-db..."

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /repo /repo
USER node
WORKDIR /repo
COPY --chown=node:node deploy/docker/migrate.sh /usr/local/bin/migrate.sh
ENTRYPOINT ["sh", "/usr/local/bin/migrate.sh"]
