import { createAuthProxy } from "@cnote/next-kit/proxy";

export const proxy = createAuthProxy({
  protectedPrefixes: ["/account", "/onboarding", "/buyer", "/rfq", "/conversations", "/wishlist"],
  signInPath: "/signin",
});

// Only run where a session matters. Public, cacheable pages (home, /c, /p, /manufacturers, sitemaps, llms.txt, ...) skip
// the proxy entirely: no token-refresh work, and never a Set-Cookie on a response a CDN might cache. Their per-user
// state comes from /api/me, which IS matched here so an expiring access token is refreshed before the page's islands ask.
export const config = {
  matcher: [
    "/account/:path*",
    "/onboarding/:path*",
    "/buyer/:path*",
    "/rfq/:path*",
    "/conversations/:path*",
    "/wishlist/:path*",
    "/compare/:path*",
    "/api/me/:path*",
    "/signin",
    "/signup",
  ],
};
