// Token refresh for Next 16 `proxy.ts` (formerly middleware). Server Components cannot set
// cookies, so each app's src/proxy.ts rotates an expired/near-expiry access token here:
//   import { createAuthProxy } from "@cnote/next-kit/proxy";
//   export const proxy = createAuthProxy({ protectedPrefixes: ["/account"], signInPath: "/signin" });
//   export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/).*)"] };
// PUBLIC CONTRACT. Extend, don't break.
import type { NextRequest, NextResponse } from "next/server";

export interface AuthProxyOptions {
  /** Paths that require a session; unauthenticated requests redirect to signInPath?next=… */
  protectedPrefixes: string[];
  signInPath: string;
}
export function createAuthProxy(opts: AuthProxyOptions): (req: NextRequest) => Promise<NextResponse> {
  void opts;
  throw new Error("not implemented");
}
