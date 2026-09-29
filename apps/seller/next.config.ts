import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Auth realm is baked in at build time: this app only ever accepts its own sessions/cookies.
  env: { CNOTE_AUTH_REALM: "seller" },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cnote/templates", "@cnote/email", "@cnote/notifications", "@cnote/developer", "@cnote/observability", "@cnote/media", "@cnote/reviews", "@cnote/next-kit", "@cnote/ui", "@cnote/core", "@cnote/ai", "@cnote/identity", "@cnote/catalogue", "@cnote/billing", "@cnote/enquiry", "@cnote/search"],
  serverExternalPackages: ["juice", "sanitize-html", "mustache", "@cnote/db", "@prisma/client", "@prisma/adapter-pg", "pg", "ioredis"],
};

// Source-map upload + release tagging only when Sentry build credentials are present; the runtime
// SDK (src/instrumentation*.ts) works without the wrapper.
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT_SELLER ?? process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
    })
  : nextConfig;
