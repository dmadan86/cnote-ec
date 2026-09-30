import { withSentryConfig } from "@sentry/nextjs/config";
import { staticHeaderList } from "@cnote/security";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl only supplies message/format helpers (server: getTranslations({ locale }), client: provider). Routing is
// the [locale] segment + src/proxy.ts, so it never makes a public page dynamic (see docs/guides/i18n.md).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Security + caching headers shared by every route. Public pages are ISR (Next adds s-maxage + stale-while-revalidate);
// the rules below add the private/no-store guarantee for account areas and long-lived caching for static assets.
const PRIVATE_AREAS = ["/account", "/onboarding", "/buyer", "/rfq", "/conversations", "/wishlist", "/compare", "/signin", "/signup", "/forgot-password", "/reset-password"];

const nextConfig: NextConfig = {
  // Auth realm is baked in at build time: this app only ever accepts its own sessions/cookies.
  env: { CNOTE_AUTH_REALM: "web" },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cnote/ads", "@cnote/promotions", "@cnote/compliance", "@cnote/metrics", "@cnote/whatsapp", "@cnote/storefront", "@cnote/domains", "@cnote/security", "@cnote/leadgen", "@cnote/templates", "@cnote/email", "@cnote/notifications", "@cnote/developer", "@cnote/observability", "@cnote/media", "@cnote/wishlist", "@cnote/reviews", "@cnote/next-kit", "@cnote/ui", "@cnote/core", "@cnote/ai", "@cnote/identity", "@cnote/catalogue", "@cnote/billing", "@cnote/enquiry", "@cnote/search"],
  serverExternalPackages: ["pdf-lib", "@cnote/live-db", "juice", "sanitize-html", "mustache", "@cnote/db", "@prisma/client", "@prisma/adapter-pg", "pg", "ioredis"],
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
      { source: "/:locale(hi|kn|ta|te|mr|gu|bn)/categories/:slug", destination: "/:locale/c/:slug", permanent: true },
    ];
  },
  async headers() {
    return [
      // Security headers + static-mode CSP for every route (public pages skip the proxy's header work). Proxy-handled
      // dynamic routes override the CSP with a per-request nonce policy.
      { source: "/:path*", headers: staticHeaderList({ app: "web" }) },
      // Account / transactional areas: never stored by a browser cache, proxy or CDN, never indexed.
      ...PRIVATE_AREAS.map((p) => ({
        source: `${p}/:path*`,
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
      // Search and supplier listings render per query but contain nothing personal (per-user bits are client islands): a
      // short shared-cache window makes repeated queries CDN hits while Redis serves the rest.
      { source: "/search", headers: [{ key: "Cache-Control", value: "public, s-maxage=60, stale-while-revalidate=300" }] },
      { source: "/:locale(hi|kn|ta|te|mr|gu|bn)/search", headers: [{ key: "Cache-Control", value: "public, s-maxage=60, stale-while-revalidate=300" }] },
      { source: "/:locale(hi|kn|ta|te|mr|gu|bn)/manufacturers", headers: [{ key: "Cache-Control", value: "public, s-maxage=120, stale-while-revalidate=600" }] },
      { source: "/manufacturers", headers: [{ key: "Cache-Control", value: "public, s-maxage=120, stale-while-revalidate=600" }] },
      // Generated social cards are pure functions of the listing: a day at the shared cache, a week stale-while-revalidate.
      { source: "/p/:slugId/:file(opengraph-image.*)", headers: [{ key: "Cache-Control", value: "public, s-maxage=86400, stale-while-revalidate=604800" }] },
      { source: "/:locale(en|hi|kn|ta|te|mr|gu|bn)/p/:slugId/:file(opengraph-image.*)", headers: [{ key: "Cache-Control", value: "public, s-maxage=86400, stale-while-revalidate=604800" }] },
      // Seed placeholder art is not fingerprinted: a day fresh, a week stale-while-revalidate.
      { source: "/placeholders/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
    ];
  },
};

// Source-map upload + release tagging only when Sentry build credentials are present; the runtime
// SDK (src/instrumentation*.ts) works without the wrapper.
const intlConfig = withNextIntl(nextConfig);

export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(intlConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT_WEB ?? process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
    })
  : intlConfig;
