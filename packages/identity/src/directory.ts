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
  /** the person's preferred language (ADR-004), e.g. "hi"; notifications render in it */
  locale: string;
}

/**
 * Contact details for a person; null when unknown or erased (DPDP).
 * By default the phone is included only when the person granted `counterparty_sharing` (safe to show another party).
 * Pass `{ self: true }` for messages sent to the person themselves (notifications, OTP): phone is always included.
 */
export async function getPersonContact(personId: string, opts?: { self?: boolean }): Promise<PersonContact | null> {
  const p = await prisma.person.findUnique({ where: { id: personId }, select: { email: true, phone: true, name: true, erasedAt: true, preferredLanguage: true } });
  if (!p || p.erasedAt) return null;
  const phone = p.phone && (opts?.self || (await hasConsent(personId, "counterparty_sharing"))) ? p.phone : null;
  return { email: p.email, phone, name: p.name, locale: p.preferredLanguage };
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

export interface PersonVerification {
  phone: string | null;
  phoneVerified: boolean;
  emailVerified: boolean;
  erased: boolean;
}

/** Verification flags for gating actions (e.g. lead-gen unlocks require a verified phone). null = unknown person. */
export async function getPersonVerification(personId: string): Promise<PersonVerification | null> {
  if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
  const p = await prisma.person.findUnique({ where: { id: personId }, select: { phone: true, phoneVerifiedAt: true, emailVerifiedAt: true, erasedAt: true } });
  if (!p) return null;
  return { phone: p.erasedAt ? null : p.phone, phoneVerified: !!p.phoneVerifiedAt && !p.erasedAt, emailVerified: !!p.emailVerifiedAt, erased: !!p.erasedAt };
}

export interface BusinessBillingProfile {
  /** legal name when declared, else the display name (GST invoices use the legal name) */
  name: string;
  gstin: string | null;
  /** single-line registered address */
  address: string;
  /** 2-digit GST state code: from the GSTIN, else the declared registered address */
  stateCode: string | null;
}

/** Billing/invoicing snapshot of a business (read-only). null = unknown business. */
export async function getBusinessBillingProfile(businessId: string): Promise<BusinessBillingProfile | null> {
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) return null;
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) return null;
  const a = (b.registeredAddress ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const address = [s("line1"), s("line2"), s("city") || b.city || "", s("state") || b.state || "", s("pincode") || b.pincode || ""].filter(Boolean).join(", ");
  const fromGstin = b.gstin && /^\d{2}[A-Z0-9]{13}$/i.test(b.gstin) ? b.gstin.slice(0, 2) : null;
  const stateCode = fromGstin ?? (/^\d{2}$/.test(s("stateCode")) ? s("stateCode") : null);
  return { name: b.legalName || b.name, gstin: b.gstin, address, stateCode };
}
