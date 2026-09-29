import "server-only";
import { ACCESS_COOKIE, getSession, type Session } from "@cnote/identity";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

/**
 * Current session or null. Cached per request. Access-token refresh happens in src/proxy.ts
 * (Server Components cannot set cookies), so an expired access token here just means "signed out".
 */
export const currentSession = cache(async (): Promise<Session | null> => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return getSession(token);
});

/** Session or redirect to sign-in (returning here afterwards). */
export async function requireSession(returnTo: string): Promise<Session> {
  const s = await currentSession();
  if (!s) redirect(`/signin?next=${encodeURIComponent(returnTo)}`);
  return s;
}

/** Session with a business, or redirect to onboarding. */
export async function requireBusiness(returnTo: string): Promise<Session & { business: NonNullable<Session["business"]> }> {
  const s = await requireSession(returnTo);
  if (!s.business) redirect(`/onboarding?next=${encodeURIComponent(returnTo)}`);
  return s as Session & { business: NonNullable<Session["business"]> };
}

export async function requireSeller(returnTo: string) {
  const s = await requireBusiness(returnTo);
  if (!s.business.isSeller) redirect(`/onboarding/seller?next=${encodeURIComponent(returnTo)}`);
  return s;
}

export async function requireOps(returnTo: string) {
  const s = await requireSession(returnTo);
  if (!s.isOps) redirect("/");
  return s;
}

export function actorOf(s: Session & { business: NonNullable<Session["business"]> }) {
  return { personId: s.personId, businessId: s.business.id };
}
