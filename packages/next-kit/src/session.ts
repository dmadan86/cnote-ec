import "server-only";
import { getSession, type AuthContext, type Session } from "@cnote/identity";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { appRealm, realmAuth, realmCookies } from "./realm";
import { clientIp } from "@cnote/security/client-ip";

export type SessionWithBusiness = Session & { business: NonNullable<Session["business"]> };

/** Current session from this app's realm cookie, or null. Cached per request (React `cache`). */
export const currentSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  return getSession(store.get(realmCookies().access)?.value, appRealm());
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

/**
 * Auth context for identity calls: ip + user agent (rate limiting, session metadata) plus this app's
 * realm and admission guard. Always pass this to identity auth functions so sessions stay in-realm.
 */
export async function requestContext(): Promise<AuthContext & { ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const ip = clientIp(h);
  return { ip, userAgent: h.get("user-agent"), ...realmAuth() };
}
