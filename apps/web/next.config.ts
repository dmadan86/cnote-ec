import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

// Security + caching headers shared by every route. Public pages are ISR (Next adds s-maxage + stale-while-revalidate);
// the rules below add the private/no-store guarantee for account areas and long-lived caching for static assets.
const PRIVATE_AREAS = ["/account", "/onboarding", "/buyer", "/rfq", "/conversations", "/wishlist", "/compare", "/signin", "/signup", "/forgot-password", "/reset-password"];

const nextConfig: NextConfig = {
  // Auth realm is baked in at build time: this app only ever accepts its own sessions/cookies.
  env: { CNOTE_AUTH_REALM: "web" },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cnote/storefront", "@cnote/domains", "@cnote/security", "@cnote/leadgen", "@cnote/templates", "@cnote/email", "@cnote/notifications", "@cnote/developer", "@cnote/observability", "@cnote/media", "@cnote/wishlist", "@cnote/reviews", "@cnote/next-kit", "@cnote/ui", "@cnote/core", "@cnote/ai", "@cnote/identity", "@cnote/catalogue", "@cnote/billing", "@cnote/enquiry", "@cnote/search"],
  serverExternalPackages: ["juice", "sanitize-html", "mustache", "@cnote/db", "@prisma/client", "@prisma/adapter-pg", "pg", "ioredis"],
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    // Listing image URLs are content-addressed by image id (a replaced photo gets a new id), so the optimiser may keep them a month.
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  async redirects() {
    return [
      // Legacy category URLs -> canonical /c/<slug> (permanent, 308). /products/<id> redirects in its page (needs the title for the slug).
      { source: "/categories/:slug", destination: "/c/:slug", permanent: true },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] },
      // Account / transactional areas: never stored by a browser cache, proxy or CDN, never indexed.
      ...PRIVATE_AREAS.map((p) => ({
        source: `${p}/:path*`,
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
      // Search and supplier listings render per query but contain nothing personal (per-user bits are client islands): a
      // short shared-cache window makes repeated queries CDN hits while Redis serves the rest.
      { source: "/search", headers: [{ key: "Cache-Control", value: "public, s-maxage=60, stale-while-revalidate=300" }] },
      { source: "/manufacturers", headers: [{ key: "Cache-Control", value: "public, s-maxage=120, stale-while-revalidate=600" }] },
      // Generated social cards are pure functions of the listing: a day at the shared cache, a week stale-while-revalidate.
      { source: "/p/:slugId/:file(opengraph-image.*)", headers: [{ key: "Cache-Control", value: "public, s-maxage=86400, stale-while-revalidate=604800" }] },
      // Seed placeholder art is not fingerprinted: a day fresh, a week stale-while-revalidate.
      { source: "/placeholders/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
    ];
  },
};

// Source-map upload + release tagging only when Sentry build credentials are present; the runtime
// SDK (src/instrumentation*.ts) works without the wrapper.
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT_WEB ?? process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
    })
  : nextConfig;
