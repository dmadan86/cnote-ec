import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { withSentryConfig } from "@sentry/nextjs/config";
import { securityHeaders, staticHeaderList } from "@cnote/security";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Monorepo env: `next dev` only reads apps/<app>/.env*, but local config lives in the repo-root .env.local (as for the
// api/worker `--env-file`). Load it when present; variables already set (CI, Docker, Playwright's e2e env) win.
const ROOT_ENV = resolve(process.cwd(), "../../.env.local");
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

// next-intl only supplies message/format helpers (server: getTranslations({ locale }), client: provider). Routing is
// the [locale] segment + src/proxy.ts, so it never makes a public page dynamic (see docs/guides/i18n.md).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Security + caching headers shared by every route. Public pages are ISR (Next adds s-maxage + stale-while-revalidate);
// the rules below add the private/no-store guarantee for account areas and long-lived caching for static assets.
const PRIVATE_AREAS = ["/account", "/onboarding", "/buyer", "/rfq", "/conversations", "/wishlist", "/compare", "/signin", "/signup", "/forgot-password", "/reset-password"];

const ADS_ON = ["1", "true", "yes"].includes((process.env.ADS_ENABLED ?? "").toLowerCase());
const SEARCH_CACHE = ADS_ON ? "private, no-store, max-age=0" : "public, s-maxage=60, stale-while-revalidate=300";
// Voice search (microphone) and search-by-photo (camera) live on the search page only (search-v2); everywhere else stays off.
const SEARCH_PERMISSIONS = { key: "Permissions-Policy", value: securityHeaders({ app: "web", microphone: true, camera: true })["Permissions-Policy"]! };

const nextConfig: NextConfig = {
  // e2e only: a second build with STOREFRONT_EMBEDS_ENABLED=1 lives in .next-embeds (e2e/setup/build.ts) next to the default one.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Auth realm is baked in at build time: this app only ever accepts its own sessions/cookies.
  // A2A_ENABLED is baked in for the (static) account menu link; the /buyer/agents pages re-check it on the server.
  env: { CNOTE_AUTH_REALM: "web", NEXT_PUBLIC_A2A_ENABLED: process.env.A2A_ENABLED ?? "", STOREFRONT_EMBEDS_ENABLED: process.env.STOREFRONT_EMBEDS_ENABLED ?? "" },
  // Dispute evidence (photos, voice notes; 8 MB per file, ADR-013) is posted through server actions; the default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "56mb" } },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cnote/credit", "@cnote/a2a", "@cnote/prices", "@cnote/escrow", "@cnote/quality", "@cnote/disputes", "@cnote/negotiation", "@cnote/verticals", "@cnote/ondc", "@cnote/ads", "@cnote/promotions", "@cnote/compliance", "@cnote/metrics", "@cnote/whatsapp", "@cnote/storefront", "@cnote/domains", "@cnote/security", "@cnote/leadgen", "@cnote/templates", "@cnote/email", "@cnote/notifications", "@cnote/developer", "@cnote/observability", "@cnote/media", "@cnote/wishlist", "@cnote/reviews", "@cnote/next-kit", "@cnote/consent", "@cnote/ui", "@cnote/core", "@cnote/ai", "@cnote/identity", "@cnote/catalogue", "@cnote/billing", "@cnote/enquiry", "@cnote/search"],
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
      // The reset token is in the URL: no Referer, ever (declared after the catch-all so it wins for the same header key).
      { source: "/reset-password", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/grievance/verify", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store, max-age=0" }] },
      // Account / transactional areas: never stored by a browser cache, proxy or CDN, never indexed.
      ...PRIVATE_AREAS.map((p) => ({
        source: `${p}/:path*`,
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
      // The service worker script and manifest must always be revalidated so an updated worker is picked up promptly.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, max-age=0, must-revalidate" }, { key: "Content-Type", value: "text/javascript; charset=utf-8" }] },
      { source: "/manifest.webmanifest", headers: [{ key: "Cache-Control", value: "public, max-age=3600" }] },
      // Search and supplier listings render per query but contain nothing personal (per-user bits are client islands): a
      // short shared-cache window makes repeated queries CDN hits while Redis serves the rest.
      // With sponsored slots on, results carry per-visitor ads (frequency caps, buyer pincode): never share them via a CDN.
      { source: "/search", headers: [{ key: "Cache-Control", value: SEARCH_CACHE }, SEARCH_PERMISSIONS] },
      { source: "/:locale(hi|kn|ta|te|mr|gu|bn)/search", headers: [{ key: "Cache-Control", value: SEARCH_CACHE }, SEARCH_PERMISSIONS] },
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
