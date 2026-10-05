// Inactive personal accounts (DPDP Rules 2025 r.8 / Third Schedule: erase after the specified period of no contact, with a 48-hour
// notice first). The decision and the notice live in @cnote/compliance; this module only answers "who is inactive" and "did they come
// back" from the tables it owns. Staff and anyone in a SELLER business are never candidates (sellers' tax-invoice and trust records
// outrank erasure, see erasePerson); buyer-only accounts are.
import { prisma } from "@cnote/db";

export interface InactiveAccount {
  personId: string;
  email: string;
  name: string | null;
  lastActiveAt: Date;
  preferredLanguage: string;
}

/** Latest sign-in / session refresh we know of (the person marker, else the newest session row, else sign-up). */
export async function getLastActiveAt(personId: string): Promise<Date | null> {
  const p = await prisma.person.findUnique({
    where: { id: personId },
    select: { createdAt: true, lastActiveAt: true, erasedAt: true, authSessions: { orderBy: { lastUsedAt: "desc" }, take: 1, select: { lastUsedAt: true } } },
  });
  if (!p || p.erasedAt) return null;
  return new Date(Math.max(p.createdAt.getTime(), p.lastActiveAt?.getTime() ?? 0, p.authSessions[0]?.lastUsedAt.getTime() ?? 0));
}

/** Eligibility that does not depend on the date: not erased, has an email for the notice, no live session, not staff, no seller business. */
const eligible = (extra: object = {}) => ({
  erasedAt: null,
  email: { not: null },
  staffMember: null,
  memberships: { none: { business: { isSeller: true } } },
  authSessions: { none: { revokedAt: null, expiresAt: { gt: new Date() } } },
  ...extra,
});

/** Re-check right before erasing: the person may have become staff, joined a seller business or signed in since the notice. */
export async function isInactivityEligible(personId: string): Promise<boolean> {
  return (await prisma.person.count({ where: eligible({ id: personId }) })) > 0;
}

/**
 * Accounts whose last activity is before `inactiveBefore`: not erased, with an email we can send the notice to, no live session,
 * not staff, not a member of a seller business. Oldest first, at most `limit`.
 */
export async function listInactiveAccounts(inactiveBefore: Date, limit = 200): Promise<InactiveAccount[]> {
  const rows = await prisma.person.findMany({
    where: {
      ...eligible(),
      createdAt: { lt: inactiveBefore },
      OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: inactiveBefore } }],
      // a session row used inside the window means activity even if the person marker lags (it is written at most daily)
      NOT: { authSessions: { some: { lastUsedAt: { gte: inactiveBefore } } } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, email: true, name: true, createdAt: true, lastActiveAt: true, preferredLanguage: true },
  });
  return rows.map((r) => ({
    personId: r.id,
    email: r.email!,
    name: r.name,
    lastActiveAt: r.lastActiveAt ?? r.createdAt,
    preferredLanguage: r.preferredLanguage,
  }));
}

/** Account lookup by email for flows that must not reveal whether it exists (nominee requests). Returns the id or null. */
export async function findPersonIdByEmail(email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  return (await prisma.person.findUnique({ where: { email: e }, select: { id: true } }))?.id ?? null;
}

/** Masked display of an account for staff screens: first letter + domain. */
export async function describePersonForStaff(personId: string): Promise<{ emailMasked: string | null; erased: boolean; createdAt: Date; lastActiveAt: Date | null } | null> {
  const p = await prisma.person.findUnique({ where: { id: personId }, select: { email: true, erasedAt: true, createdAt: true, lastActiveAt: true } });
  if (!p) return null;
  const emailMasked = p.email ? `${p.email.slice(0, 1)}***@${p.email.split("@")[1] ?? ""}` : null;
  return { emailMasked, erased: !!p.erasedAt, createdAt: p.createdAt, lastActiveAt: p.lastActiveAt };
}
