# syntax=docker/dockerfile:1.7
# @cnote/api (Node). Build from the REPO ROOT:  docker build -f apps/api/Dockerfile -t cnote-api .
# Runtime choice: tsx (no compile step). Internal packages export TypeScript source (package.json "exports" -> ./src/*.ts,
# ADR-026), so a `tsc` build would need every package bundled first. tsx keeps dev and prod identical; cost is ~1s
# extra cold start and ~60 MB RAM. Follow-up: esbuild bundle per entrypoint (externals: @prisma/client, pg, ioredis, sharp).

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
    pnpm install --offline --frozen-lockfile -w --filter "@cnote/api..."

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /repo /repo
RUN mkdir -p /data/media && chown node:node /data/media
USER node
WORKDIR /repo/apps/api
ENV PORT=3003
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node is PID 1 (no pnpm wrapper) so SIGTERM reaches the process.
CMD ["node", "--import", "tsx", "src/server.ts"]
