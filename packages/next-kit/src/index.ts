// @cnote/next-kit — Next.js integration shared by apps/web, apps/seller and apps/admin:
// cookie-based sessions on top of @cnote/identity, auth route handlers, server actions, and
// action/route error helpers. Server-only entry; client components live in "@cnote/next-kit/client",
// the token-refresh proxy in "@cnote/next-kit/proxy".
// PUBLIC CONTRACT — apps depend on these signatures. Extend, don't break.
import "server-only";
import type { Session } from "@cnote/identity";
import type { NextRequest } from "next/server";

export * from "./action-result";

export type SessionWithBusiness = Session & { business: NonNullable<Session["business"]> };

/** Current session from the access-token cookie, or null. Cached per request (React `cache`). */
export async function currentSession(): Promise<Session | null> {
  throw new Error("not implemented");
}
/** Session or redirect to `${signInPath}?next=returnTo`. */
export async function requireSession(returnTo: string, opts?: { signInPath?: string }): Promise<Session> {
  void returnTo; void opts;
  throw new Error("not implemented");
}
/** Session with a business, or redirect to `onboardingPath?next=returnTo`. */
export async function requireBusiness(returnTo: string, opts?: { signInPath?: string; onboardingPath?: string }): Promise<SessionWithBusiness> {
  void returnTo; void opts;
  throw new Error("not implemented");
}
export function actorOf(s: SessionWithBusiness): { personId: string; businessId: string } {
  return { personId: s.personId, businessId: s.business.id };
}
/** Request context (ip, user agent) for rate limiting and session metadata, from next/headers. */
export async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  throw new Error("not implemented");
}

/**
 * Catch-all auth route. Mount in each app as `src/app/api/auth/[action]/route.ts`:
 *   export { authRoute as GET, authRoute as POST } from "@cnote/next-kit";
 * Actions: google (start), google-callback, refresh, signout.
 */
export async function authRoute(req: NextRequest, ctx: { params: Promise<{ action: string }> }): Promise<Response> {
  void req; void ctx;
  throw new Error("not implemented");
}

// Server actions ("use server" in their own module), used by the client forms.
export { signInAction, signUpAction, forgotPasswordAction, resetPasswordAction, signOutAction } from "./actions";
