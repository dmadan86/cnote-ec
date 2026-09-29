import { createAuthProxy } from "@cnote/next-kit/proxy";
import { createNonce, pathMatches, withNonceRequest, withSecurityHeaders } from "@cnote/next-kit/security";
import type { NextRequest, NextResponse } from "next/server";

// Public: "/", /signin, /signup, /forgot-password, /reset-password, /mfa, static assets. Everything else needs a session.
const authProxy = createAuthProxy({
  protectedPrefixes: ["/onboarding", "/dashboard", "/leads", "/conversations", "/listings", "/billing", "/verification", "/settings"],
  signInPath: "/signin",
});

// Every seller page is rendered per request except these statically generated ones, which cannot carry a nonce
// and so get the static-mode CSP. Add a path here if you add a page that reads no cookies/searchParams/headers.
const STATIC_PATHS = ["/forgot-password"];

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const nonce = pathMatches(req.nextUrl.pathname, STATIC_PATHS) ? undefined : createNonce();
  const res = await authProxy(nonce ? withNonceRequest(req, nonce, { app: "seller" }) : req);
  return withSecurityHeaders(res, { app: "seller", nonce });
}

export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/|.*\\..*).*)"] };
