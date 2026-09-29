// Public person/business lookups for other modules (replaces their cross-module table reads).
// ADR-010: return only what the caller needs; erased persons are tombstones and never leak PII.
import { prisma } from "@cnote/db";
import { hasConsent } from "./consent";
import { normaliseEmail } from "./password";

export { hashPassword } from "./password";

export interface BusinessMemberView {
  personId: string;
  role: "owner" | "staff";
}

/** Members of a business; `ownersOnly` narrows to role=owner. */
export async function listBusinessMembers(businessId: string, opts?: { ownersOnly?: boolean }): Promise<BusinessMemberView[]> {
  return prisma.businessMember.findMany({
    where: { businessId, ...(opts?.ownersOnly ? { role: "owner" } : {}) },
    select: { personId: true, role: true },
    orderBy: { personId: "asc" },
  });
}

export async function isBusinessMember(personId: string, businessId: string): Promise<boolean> {
  const row = await prisma.businessMember.findUnique({
    where: { businessId_personId: { businessId, personId } },
    select: { personId: true },
  });
  return row !== null;
}

export interface PersonContact {
  email: string | null;
  phone: string | null;
  name: string | null;
}

/**
 * Contact details for a person; null when unknown or erased (DPDP).
 * By default the phone is included only when the person granted `counterparty_sharing` (safe to show another party).
 * Pass `{ self: true }` for messages sent to the person themselves (notifications, OTP): phone is always included.
 */
export async function getPersonContact(personId: string, opts?: { self?: boolean }): Promise<PersonContact | null> {
  const p = await prisma.person.findUnique({ where: { id: personId }, select: { email: true, phone: true, name: true, erasedAt: true } });
  if (!p || p.erasedAt) return null;
  const phone = p.phone && (opts?.self || (await hasConsent(personId, "counterparty_sharing"))) ? p.phone : null;
  return { email: p.email, phone, name: p.name };
}

/** Lookup by (case-insensitive) email; never returns erased persons. */
export async function getPersonByEmail(email: string): Promise<{ id: string; name: string | null; email: string } | null> {
  const p = await prisma.person.findUnique({ where: { email: normaliseEmail(email) }, select: { id: true, name: true, email: true, erasedAt: true } });
  if (!p || p.erasedAt || !p.email) return null;
  return { id: p.id, name: p.name, email: p.email };
}

export interface PersonSummary {
  id: string;
  name: string | null;
  /** masked, e.g. "d***@gmail.com", unless `unmasked: true` (staff tools) */
  email: string | null;
}

export const maskEmail = (email: string | null): string | null => {
  if (!email) return null;
  const at = email.indexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
};

export async function getPersonSummaries(ids: string[], opts?: { unmasked?: boolean }): Promise<Map<string, PersonSummary>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.person.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true, erasedAt: true } });
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, name: r.erasedAt ? null : r.name, email: r.erasedAt ? null : opts?.unmasked ? r.email : maskEmail(r.email) },
    ]),
  );
}

/** true when the person is unknown or erased (DPDP): callers must not message them. */
export async function isPersonErased(personId: string): Promise<boolean> {
  const p = await prisma.person.findUnique({ where: { id: personId }, select: { erasedAt: true } });
  return !p || p.erasedAt !== null;
}

export interface PersonBusinessView {
  businessId: string;
  name: string;
  role: "owner" | "staff";
  isSeller: boolean;
  isBuyer: boolean;
  verificationTier: number;
  badgeActive: boolean;
}

export async function getPersonBusinesses(personId: string): Promise<PersonBusinessView[]> {
  const rows = await prisma.businessMember.findMany({
    where: { personId },
    select: { role: true, business: { select: { id: true, name: true, isSeller: true, isBuyer: true, verificationTier: true, badgeActive: true } } },
    orderBy: { business: { createdAt: "asc" } },
  });
  return rows.map((r) => ({
    businessId: r.business.id, name: r.business.name, role: r.role, isSeller: r.business.isSeller, isBuyer: r.business.isBuyer,
    verificationTier: r.business.verificationTier, badgeActive: r.business.badgeActive,
  }));
}
