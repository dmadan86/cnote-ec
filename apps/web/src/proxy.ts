import { createAuthProxy } from "@cnote/next-kit/proxy";
import { createNonce, pathMatches, withNonceRequest, withSecurityHeaders } from "@cnote/next-kit/security";
import { NextResponse, type NextRequest } from "next/server";
import { WEB_NONCE_SECURITY } from "@/features/rail/csp";
import { recordStorefrontHit, routeStorefrontHost } from "@/features/domains/host-routing";
import { DEFAULT_LOCALE, disabledLocaleRest, isLocalizedPath, splitLocale } from "@/i18n/config";

const PROTECTED = ["/account", "/onboarding", "/buyer", "/rfq", "/conversations", "/wishlist"];
const authProxy = createAuthProxy({ protectedPrefixes: PROTECTED, signInPath: "/signin" });

// Security headers on every response this proxy handles (redirects included). Per-request-rendered pages get a
// strict nonce-based CSP (script-src 'nonce-…' 'strict-dynamic'); statically generated / ISR pages cannot carry a
// per-request nonce, so they get the same policy in static mode ('unsafe-inline' scripts) until they are made
// dynamic. Keep NONCE_PATHS to routes that are always dynamic (they read cookies/searchParams), otherwise the
// static HTML's scripts lack the nonce and hydration is blocked. Set CSP_REPORT_ONLY=1 to observe before enforcing.
const NONCE_PATHS = [...PROTECTED, "/signin", "/signup", "/reset-password"];

/** Paths that need the auth proxy (session refresh / protection) on the marketplace host. */
const SESSION_PATHS = [...PROTECTED, "/compare", "/api/me", "/signin", "/signup"];

/**
 * Locale routing for public pages (docs/guides/i18n.md). Pure path logic: no cookies, no Accept-Language, no I/O, so
 * every response stays CDN-cacheable and crawlers always get the URL they asked for.
 *   /x            -> rewrite to /en/x (the default locale is unprefixed in the browser, prefixed internally)
 *   /hi/x         -> pass through (static [locale] route)
 *   /en/x         -> 308 to /x (one canonical URL per language, no duplicate content)
 *   /kn/x         -> 307 to /x (disabled locale, see LOCALES in i18n/config: old links keep working in English)
 *   /hi/<other>   -> 307 to /<other> (only public discovery pages are localised; the rest stays unprefixed English)
 * Returns null when the path is not a localised page (account, buyer, rfq, auth, api, storefront-rewritten, ...).
 */
function routeLocale(req: NextRequest): NextResponse | null {
  const { pathname, search } = req.nextUrl;
  const off = disabledLocaleRest(pathname);
  if (off !== null) return NextResponse.redirect(new URL(`${off}${search}`, req.url), 307);
  const { locale, prefixed, rest } = splitLocale(pathname);
  if (prefixed && locale === DEFAULT_LOCALE) {
    // Generated metadata images (og image) are emitted under the internal /en prefix; leave those alone.
    if (pathname.includes("opengraph-image")) return null;
    return NextResponse.redirect(new URL(`${rest === "/" ? "/" : rest}${search}`, req.url), 308);
  }
  if (prefixed) {
    return isLocalizedPath(rest) ? NextResponse.next() : NextResponse.redirect(new URL(`${rest}${search}`, req.url), 307);
  }
  if (!isLocalizedPath(rest)) return null;
  const url = req.nextUrl.clone();
  url.pathname = rest === "/" ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${rest}`;
  return NextResponse.rewrite(url);
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  // HOST ROUTING first: seller custom domains and <slug>.<root> subdomains are rewritten to /store/<slug>/…
  // (resolveHost answers platform hosts without I/O). Metering is fire-and-forget and never blocks the response.
  recordStorefrontHit(req);
  const routed = await routeStorefrontHost(req);
  if (routed) return withSecurityHeaders(routed, { app: "web" });

  // LOCALE ROUTING for public pages. Runs before the session paths (none of them are localised).
  const localised = routeLocale(req);
  if (localised) return localised;

  // Public marketplace pages stay proxy-free in effect: no auth work and never a Set-Cookie on a response a CDN may
  // cache. Their headers come from next.config headers() (staticHeaderList).
  if (!pathMatches(req.nextUrl.pathname, SESSION_PATHS)) return NextResponse.next();

  const nonce = pathMatches(req.nextUrl.pathname, NONCE_PATHS) ? createNonce() : undefined;
  const res = await authProxy(nonce ? withNonceRequest(req, nonce, WEB_NONCE_SECURITY) : req);
  return withSecurityHeaders(res, nonce ? { ...WEB_NONCE_SECURITY, nonce } : { app: "web" }, req.nextUrl.pathname);
}

// Runs on every page request: storefront custom domains/subdomains can hit ANY path, and host matching can't be
// expressed statically (the domains are dynamic). Public marketplace pages exit on the fast path above with no
// cookies and no I/O, so they stay CDN-cacheable; their per-user state comes from /api/me (which does refresh tokens).
export const config = {
  // api/rfq and api/disputes are multipart upload routes with their own size caps (@cnote/next-kit readBoundedFormData): keeping them out
  // of the proxy stops Next from cloning/buffering (and silently truncating at proxyClientMaxBodySize) their large bodies.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|placeholders/|media/v/|api/rfq$|api/rfq/bom$|api/disputes$|api/goods-receipts$).*)"],
};
