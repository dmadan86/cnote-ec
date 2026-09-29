import { createAuthProxy } from "@cnote/next-kit/proxy";

// Public: "/", /signin, /signup, /forgot-password, /reset-password, static assets. Everything else needs a session.
export const proxy = createAuthProxy({
  protectedPrefixes: ["/onboarding", "/dashboard", "/leads", "/conversations", "/listings", "/billing", "/verification", "/settings"],
  signInPath: "/signin",
});

export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/|.*\\..*).*)"] };
