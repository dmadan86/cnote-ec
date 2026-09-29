// Token refresh for Next 16 `proxy.ts` (formerly middleware). Server Components cannot set
// cookies, so each app's src/proxy.ts rotates an expired/near-expiry access token here:
//   import { createAuthProxy } from "@cnote/next-kit/proxy";
//   export const proxy = createAuthProxy({ protectedPrefixes: ["/account"], signInPath: "/signin" });
//   export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/).*)"] };
// PUBLIC CONTRACT. Extend, don't break.
import { DomainError } from "@cnote/core";
import { ACCESS_COOKIE, REFRESH_COOKIE, refreshSession, type AuthTokens } from "@cnote/identity";
import { NextResponse, type NextRequest } from "next/server";
import { clearAuthCookies, jwtExp, setAuthCookies } from "./cookies";

export interface AuthProxyOptions {
  /** Paths that require a session; unauthenticated requests redirect to signInPath?next=… */
  protectedPrefixes: string[];
  signInPath: string;
}

const REFRESH_SKEW_SECONDS = 30;

export function createAuthProxy(opts: AuthProxyOptions): (req: NextRequest) => Promise<NextResponse> {
  const isProtected = (path: string) => opts.protectedPrefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));

  return async function proxy(req) {
    let access = req.cookies.get(ACCESS_COOKIE)?.value;
    const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
    let rotated: AuthTokens | null = null;
    let cleared = false;

    const exp = jwtExp(access);
    const stale = exp === null || exp - Date.now() / 1000 < REFRESH_SKEW_SECONDS;
    if (stale && refresh) {
      try {
        rotated = await refreshSession(refresh, {
          ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || null,
          userAgent: req.headers.get("user-agent"),
        });
      } catch (err) {
        // Only an authoritative rejection clears cookies; transient errors (DB/Redis down) keep them for the next request.
        if (err instanceof DomainError && err.code === "unauthenticated") cleared = true;
        else console.error("auth proxy refresh failed", err);
      }
    }
    if (rotated) {
      // Forward to this request too, so Server Components rendered now see the new tokens.
      req.cookies.set(ACCESS_COOKIE, rotated.accessToken);
      req.cookies.set(REFRESH_COOKIE, rotated.refreshToken);
      access = rotated.accessToken;
    } else if (cleared) {
      req.cookies.delete(ACCESS_COOKIE);
      req.cookies.delete(REFRESH_COOKIE);
      access = undefined;
    }

    if (!rotated && access && exp !== null && exp < Date.now() / 1000) access = undefined; // expired and not refreshable

    const finish = (res: NextResponse) => {
      if (rotated) setAuthCookies(res.cookies, rotated);
      else if (cleared) clearAuthCookies(res.cookies);
      return res;
    };

    const { pathname, search } = req.nextUrl;
    if (isProtected(pathname) && !access) {
      const url = new URL(opts.signInPath, req.url);
      url.searchParams.set("next", pathname + search);
      return finish(NextResponse.redirect(url));
    }
    return finish(NextResponse.next({ request: { headers: req.headers } }));
  };
}
