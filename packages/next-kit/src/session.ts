import "server-only";
import { getSession, ACCESS_COOKIE, type Session } from "@cnote/identity";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

export type SessionWithBusiness = Session & { business: NonNullable<Session["business"]> };

/** Current session from the access-token cookie, or null. Cached per request (React `cache`). */
export const currentSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  return getSession(store.get(ACCESS_COOKIE)?.value);
});

const signInUrl = (path: string, returnTo: string) => `${path}?next=${encodeURIComponent(returnTo)}`;

/** Session or redirect to `${signInPath}?next=returnTo`. */
export async function requireSession(returnTo: string, opts?: { signInPath?: string }): Promise<Session> {
  const s = await currentSession();
  if (!s) redirect(signInUrl(opts?.signInPath ?? "/signin", returnTo));
  return s;
}

/** Session with a business, or redirect to `onboardingPath?next=returnTo`. */
export async function requireBusiness(returnTo: string, opts?: { signInPath?: string; onboardingPath?: string }): Promise<SessionWithBusiness> {
  const s = await requireSession(returnTo, opts);
  if (!s.business) redirect(signInUrl(opts?.onboardingPath ?? "/onboarding", returnTo));
  return s as SessionWithBusiness;
}

export function actorOf(s: SessionWithBusiness): { personId: string; businessId: string } {
  return { personId: s.personId, businessId: s.business.id };
}

/** Request context (ip, user agent) for rate limiting and session metadata, from next/headers. */
export async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || null;
  return { ip, userAgent: h.get("user-agent") };
}
