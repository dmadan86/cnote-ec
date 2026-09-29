import { createAuthProxy } from "@cnote/next-kit/proxy";

export const proxy = createAuthProxy({
  protectedPrefixes: ["/account", "/onboarding", "/buyer", "/rfq", "/conversations", "/wishlist"],
  signInPath: "/signin",
});

export const config = { matcher: ["/((?!_next/|favicon.ico|api/auth/).*)"] };
