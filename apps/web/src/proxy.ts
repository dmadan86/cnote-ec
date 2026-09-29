import { createAuthProxy } from "@cnote/next-kit/proxy";
import { createNonce, pathMatches, withNonceRequest, withSecurityHeaders } from "@cnote/next-kit/security";
import { NextResponse, type NextRequest } from "next/server";
import { recordStorefrontHit, routeStorefrontHost } from "@/features/domains/host-routing";

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

export async function proxy(req: NextRequest): Promise<NextResponse> {
  // HOST ROUTING first: seller custom domains and <slug>.<root> subdomains are rewritten to /store/<slug>/…
  // (resolveHost answers platform hosts without I/O). Metering is fire-and-forget and never blocks the response.
  recordStorefrontHit(req);
  const routed = await routeStorefrontHost(req);
  if (routed) return withSecurityHeaders(routed, { app: "web" });

  // Public marketplace pages stay proxy-free in effect: no auth work and never a Set-Cookie on a response a CDN may
  // cache. Their headers come from next.config headers() (staticHeaderList).
  if (!pathMatches(req.nextUrl.pathname, SESSION_PATHS)) return NextResponse.next();

  const nonce = pathMatches(req.nextUrl.pathname, NONCE_PATHS) ? createNonce() : undefined;
  const res = await authProxy(nonce ? withNonceRequest(req, nonce, { app: "web" }) : req);
  return withSecurityHeaders(res, { app: "web", nonce });
}

// Runs on every page request: storefront custom domains/subdomains can hit ANY path, and host matching can't be
// expressed statically (the domains are dynamic). Public marketplace pages exit on the fast path above with no
// cookies and no I/O, so they stay CDN-cacheable; their per-user state comes from /api/me (which does refresh tokens).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|placeholders/|media/v/).*)"],
};
