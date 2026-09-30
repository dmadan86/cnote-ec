import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Auth realm is baked in at build time: this app only ever accepts its own sessions/cookies.
  env: { CNOTE_AUTH_REALM: "seller" },
  // Bulk import uploads (CSV/XLSX/ZIP with images) stream through the proxy: allow up to 200 MB.
  // Dispute evidence (8 MB per file, ADR-013) goes through server actions; the default action body limit is 1 MB.
  experimental: { proxyClientMaxBodySize: "200mb", serverActions: { bodySizeLimit: "20mb" } },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cnote/escrow", "@cnote/quality", "@cnote/disputes", "@cnote/negotiation", "@cnote/verticals", "@cnote/ondc", "@cnote/ads", "@cnote/promotions", "@cnote/wishlist", "@cnote/compliance", "@cnote/metrics", "@cnote/whatsapp", "@cnote/bulk", "@cnote/storefront", "@cnote/domains", "@cnote/security", "@cnote/leadgen", "@cnote/templates", "@cnote/email", "@cnote/notifications", "@cnote/developer", "@cnote/observability", "@cnote/media", "@cnote/reviews", "@cnote/next-kit", "@cnote/ui", "@cnote/core", "@cnote/ai", "@cnote/identity", "@cnote/catalogue", "@cnote/billing", "@cnote/enquiry", "@cnote/search"],
  serverExternalPackages: ["pdf-lib", "exceljs", "@cnote/live-db", "juice", "sanitize-html", "mustache", "@cnote/db", "@prisma/client", "@prisma/adapter-pg", "pg", "ioredis"],
};

// Source-map upload + release tagging only when Sentry build credentials are present; the runtime
// SDK (src/instrumentation*.ts) works without the wrapper.
const intlConfig = withNextIntl(nextConfig);

export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(intlConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT_SELLER ?? process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
    })
  : intlConfig;
