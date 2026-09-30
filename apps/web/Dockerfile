# syntax=docker/dockerfile:1.7
# @cnote/web (Next.js 16). Build from the REPO ROOT:  docker build -f apps/web/Dockerfile -t cnote-web .
# Workspace packages ship TypeScript source, so the runtime image keeps the pruned workspace and runs `next start`.
# Follow-up (needs next.config.ts change, not done here): output: "standalone" + outputFileTracingRoot would shrink the image ~5x.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
# openssl: Prisma; ca-certificates: outbound TLS (Sentry, R2/S3, SMTP)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo

# 1) Resolve + download every dependency from the lockfile only (cached until the lockfile changes).
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# 2) Install just this app and its workspace dependencies, then build.
FROM fetch AS build
COPY . .
# -w keeps root devDependencies (typescript, tsx). `postinstall` runs prisma generate for @cnote/db.
# prisma.config.ts reads DATABASE_URL at generate time; a placeholder is enough (no connection is made).
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    LIVE_DATABASE_URL=postgres://build:build@localhost:5432/build_live \
    pnpm install --offline --frozen-lockfile -w --filter "@cnote/web..."
# Public build-time values are inlined into the client bundle. Secrets must NOT be passed as build args.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=""
ARG NEXT_PUBLIC_SENTRY_RELEASE=""
ARG NEXT_PUBLIC_CLARITY_PROJECT_ID=""
ENV NEXT_PUBLIC_CLARITY_PROJECT_ID=$NEXT_PUBLIC_CLARITY_PROJECT_ID
# Some pages call generateStaticParams against the DB. If the build has no reachable database, pass
# --build-arg DATABASE_URL=... with --network host (or build inside compose); see docs/architecture/portability.md.
ARG DATABASE_URL=postgres://cnote:cnote@host.docker.internal:5432/cnote
# Published listings (CQRS read DB) are read by generateStaticParams as well.
ARG LIVE_DATABASE_URL=postgres://cnote:cnote@host.docker.internal:5432/cnote_live
ARG REDIS_URL=redis://host.docker.internal:6379
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE
RUN pnpm --filter @cnote/web build

# 3) Runtime: same base, non-root, no build caches from the dependency stage.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /repo /repo
RUN mkdir -p /data/media && chown node:node /data/media
USER node
WORKDIR /repo/apps/web
EXPOSE 3000
# "/" may redirect to sign-in in seller/admin; any status below 500 means the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "exec", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
