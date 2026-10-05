import { createAuthProxy } from "@cnote/next-kit/proxy";
import { createNonce, pathMatches, withNonceRequest, withSecurityHeaders } from "@cnote/next-kit/security";
import type { NextRequest, NextResponse } from "next/server";
import { requireSellerConsent } from "@/features/consent/server";

// Public: "/", /signin, /signup, /forgot-password, /reset-password, /mfa, static assets. Everything else needs a session.
const authProxy = createAuthProxy({
  protectedPrefixes: ["/onboarding", "/dashboard", "/leads", "/conversations", "/listings", "/billing", "/verification", "/settings", "/orders", "/reviews", "/questions", "/appeals", "/notifications", "/storefront", "/offers", "/referrals", "/ads", "/ondc", "/price-book", "/disputes", "/prices", "/credit", "/agents", "/samples"],
  signInPath: "/signin",
});

// Every seller page is rendered per request (the root layout reads the language cookie), so every page gets a nonce.
// Add a path to STATIC_PATHS only for a page that is statically generated (reads no cookies/searchParams/headers).
const VOICE_PATHS = ["/listings/new", "/onboarding"];
const STATIC_PATHS: string[] = [];

const REF_COOKIE = "seller_ref";
const REF_RE = /^[A-Za-z0-9_-]{4,64}$/;

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const nonce = pathMatches(req.nextUrl.pathname, STATIC_PATHS) ? undefined : createNonce();
  // Voice drafts (ADR-004) record with MediaRecorder on the listing-creation screens only.
  const microphone = pathMatches(req.nextUrl.pathname, VOICE_PATHS);
  const res = await authProxy(nonce ? withNonceRequest(req, nonce, { app: "seller", microphone }) : req);
  // Referral links (ADR-025) land on any page as ?ref=CODE; remember it until the business is created at onboarding. The code is
  // attribution (marketing), so it is stored only with the seller's consent; when consent is granted afterwards on this page the
  // consent manager posts the code to /api/consent/ref (docs/design/cookie-consent.md).
  const ref = req.nextUrl.searchParams.get("ref");
  if (ref && REF_RE.test(ref) && requireSellerConsent(req, "marketing")) res.cookies.set(REF_COOKIE, ref, { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  return withSecurityHeaders(res, { app: "seller", nonce, microphone }, req.nextUrl.pathname);
}

export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/|.*\\..*).*)"] };
