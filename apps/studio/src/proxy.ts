import { createAuthProxy } from "@cnote/next-kit/proxy";

// Everything needs a seller session except the sign-in page, token-signed previews, auth routes and static assets.
export const proxy = createAuthProxy({ protectedPrefixes: ["/"], signInPath: "/signin" });

export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/|signin|preview/|media/|.*\\..*).*)"] };
