// Next 16 proxy (formerly middleware): auth gate + security headers for the privileged admin app.
// The proxy only checks that a session exists (and refreshes tokens); STAFF membership and privileges
// are enforced again server-side in every layout/page/action (see src/lib/auth.ts). Never rely on this file alone.
import { createAuthProxy } from "@cnote/next-kit/proxy";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/signin", "/forgot-password", "/reset-password"];
const authProxy = createAuthProxy({ protectedPrefixes: ["/"], signInPath: "/signin" });

function harden(res: NextResponse): NextResponse {
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open = pathname.startsWith("/api/auth/") || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return harden(open ? NextResponse.next() : await authProxy(req));
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
