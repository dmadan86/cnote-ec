// Next 16 proxy (formerly middleware): auth gate + security headers for the privileged admin app.
// The proxy only checks that a session exists (and refreshes tokens) and that the person has MFA; STAFF membership
// and privileges are enforced again server-side in every layout/page/action (see src/lib/auth.ts). Never rely on this file alone.
import { createAuthProxy } from "@cnote/next-kit/proxy";
import { createNonce, enforceMfaEnrolled, pathMatches, withNonceRequest, withSecurityHeaders } from "@cnote/next-kit/security";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/signin", "/forgot-password", "/reset-password", "/mfa", "/api/csp-report"];
// Reachable with a session that has no MFA yet (so it can enrol) — everything else redirects to the enrolment page.
const MFA_EXEMPT = [...PUBLIC_PATHS, "/api/auth", "/account/security", "/no-access"];
// Statically generated pages cannot carry a CSP nonce; they get the static-mode policy. Everything else is dynamic.
const STATIC_PATHS = ["/forgot-password"];
const authProxy = createAuthProxy({ protectedPrefixes: ["/"], signInPath: "/signin" });

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open = pathMatches(pathname, ["/api/auth", ...PUBLIC_PATHS]);
  const nonce = pathMatches(pathname, STATIC_PATHS) ? undefined : createNonce();
  const inner = nonce ? withNonceRequest(req, nonce, { app: "admin" }) : req;

  let res: NextResponse = open ? NextResponse.next({ request: { headers: inner.headers } }) : await authProxy(inner);
  if (!open && !res.headers.has("location")) {
    const gate = await enforceMfaEnrolled(inner, { exemptPrefixes: MFA_EXEMPT, redirectTo: "/account/security?setup=1" });
    if (gate) {
      for (const c of res.headers.getSetCookie()) gate.headers.append("set-cookie", c); // keep any rotated auth cookies
      res = gate;
    }
  }
  res.headers.set("Cache-Control", "no-store");
  return withSecurityHeaders(res, { app: "admin", nonce });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
