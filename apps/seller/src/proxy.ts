import { createAuthProxy } from "@cnote/next-kit/proxy";
import { createNonce, pathMatches, withNonceRequest, withSecurityHeaders } from "@cnote/next-kit/security";
import type { NextRequest, NextResponse } from "next/server";

// Public: "/", /signin, /signup, /forgot-password, /reset-password, /mfa, static assets. Everything else needs a session.
const authProxy = createAuthProxy({
  protectedPrefixes: ["/onboarding", "/dashboard", "/leads", "/conversations", "/listings", "/billing", "/verification", "/settings", "/orders", "/reviews", "/appeals", "/notifications", "/storefront", "/offers", "/referrals", "/ads", "/ondc", "/price-book", "/disputes"],
  signInPath: "/signin",
});

// Every seller page is rendered per request except these statically generated ones, which cannot carry a nonce
// and so get the static-mode CSP. Add a path here if you add a page that reads no cookies/searchParams/headers.
const VOICE_PATHS = ["/listings/new", "/onboarding"];
const STATIC_PATHS = ["/forgot-password"];

const REF_COOKIE = "seller_ref";
const REF_RE = /^[A-Za-z0-9_-]{4,64}$/;

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const nonce = pathMatches(req.nextUrl.pathname, STATIC_PATHS) ? undefined : createNonce();
  // Voice drafts (ADR-004) record with MediaRecorder on the listing-creation screens only.
  const microphone = pathMatches(req.nextUrl.pathname, VOICE_PATHS);
  const res = await authProxy(nonce ? withNonceRequest(req, nonce, { app: "seller", microphone }) : req);
  // Referral links (ADR-025) land on any page as ?ref=CODE; remember it until the business is created at onboarding.
  const ref = req.nextUrl.searchParams.get("ref");
  if (ref && REF_RE.test(ref)) res.cookies.set(REF_COOKIE, ref, { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  return withSecurityHeaders(res, { app: "seller", nonce, microphone });
}

export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/|.*\\..*).*)"] };
