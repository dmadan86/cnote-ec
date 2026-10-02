# syntax=docker/dockerfile:1.7
# @cnote/admin-app (Next.js 16). Build from the REPO ROOT:  docker build -f apps/admin/Dockerfile -t cnote-admin .
# Workspace packages ship TypeScript source, so the runtime image keeps the pruned workspace and runs `next start`.
# Follow-up (needs next.config.ts change, not done here): output: "standalone" + outputFileTracingRoot would shrink the image ~5x.

# Pinned by digest (supply chain). Refresh: docker buildx imagetools inspect node:22-bookworm-slim, or let Dependabot (docker) do it.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
FROM ${NODE_IMAGE} AS base
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
    pnpm install --offline --frozen-lockfile -w --filter "@cnote/admin-app..."
# Public build-time values are inlined into the client bundle. Secrets must NOT be passed as build args.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=""
ARG NEXT_PUBLIC_SENTRY_RELEASE=""
# Some pages call generateStaticParams against the DB, so `next build` needs a reachable database.
# NO CREDENTIALS AS BUILD ARGS: --build-arg values are stored in the image history and visible to anyone who can pull it. The values
# below are non-secret LOCAL-DEV PLACEHOLDERS (Docker Desktop maps host.docker.internal; on Linux add
# `--add-host=host.docker.internal:host-gateway`). To build against another database, provide the real URLs as a BUILD SECRET, which is
# mounted for the build step only and never written to a layer:
#   printf 'DATABASE_URL=...\nLIVE_DATABASE_URL=...\nREDIS_URL=...\n' > build.env   # keep it out of git
#   docker build --secret id=build_env,src=build.env -f <this file> .
# (docker compose: see build.secrets in docker-compose.apps.yml; CI: `secrets:` on docker/build-push-action.)
ENV DATABASE_URL=postgres://cnote:cnote@host.docker.internal:5432/cnote \
    LIVE_DATABASE_URL=postgres://cnote:cnote@host.docker.internal:5432/cnote_live \
    REDIS_URL=redis://host.docker.internal:6379
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE
RUN --mount=type=secret,id=build_env \
    set -a; if [ -f /run/secrets/build_env ]; then . /run/secrets/build_env; fi; set +a; \
    pnpm --filter @cnote/admin-app build

# 3) Runtime: same base, non-root, no build caches from the dependency stage.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /repo /repo
RUN mkdir -p /data/media && chown node:node /data/media
USER node
WORKDIR /repo/apps/admin
EXPOSE 3001
# "/" may redirect to sign-in in seller/admin; any status below 500 means the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "exec", "next", "start", "-p", "3001", "-H", "0.0.0.0"]
