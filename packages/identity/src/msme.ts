// MSME status of a business and the party facts a commercial document needs (purchase orders, supplier invoices).
// IT Act s.43B(h) / MSMED Act s.15 only protect MICRO and SMALL enterprises, and (per Udyam practice) the enterprise must
// hold an Udyam registration. Size class is SELLER-DECLARED here (the Udyam number alone does not carry it); the payment
// due-date tracking in @cnote/enquiry reads it through getMsmeStatus. See docs/design/purchase-orders.md.
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { bustSellerCaches } from "./business";
import { GST_STATES, isValidUdyam } from "./gstin";

export const MSME_CATEGORIES = ["micro", "small", "medium"] as const;
export type MsmeCategory = (typeof MSME_CATEGORIES)[number];
export const isMsmeCategory = (v: unknown): v is MsmeCategory => typeof v === "string" && (MSME_CATEGORIES as readonly string[]).includes(v);

export interface MsmeStatus {
  businessId: string;
  /** seller-declared size class, null when not declared */
  category: MsmeCategory | null;
  declaredAt: string | null;
  /** a syntactically valid Udyam number is on file (the number itself is not returned) */
  udyamOnFile: boolean;
  /** micro or small AND an Udyam number on file: the buyer's payment is subject to the s.43B(h) time limit */
  covered: boolean;
}

export function msmeCovered(category: string | null | undefined, udyam: string | null | undefined): boolean {
  return (category === "micro" || category === "small") && !!udyam && isValidUdyam(udyam);
}

export async function getMsmeStatus(businessId: string): Promise<MsmeStatus | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, udyam: true, msmeCategory: true, msmeDeclaredAt: true } });
  if (!b) return null;
  return {
    businessId: b.id,
    category: isMsmeCategory(b.msmeCategory) ? b.msmeCategory : null,
    declaredAt: b.msmeDeclaredAt?.toISOString() ?? null,
    udyamOnFile: !!b.udyam && isValidUdyam(b.udyam),
    covered: msmeCovered(b.msmeCategory, b.udyam),
  };
}

/**
 * Seller declares (or clears with null) the MSME size class of their business. The declaration is the seller's own statement:
 * the buyer-facing due dates carry "seller-declared" wording and staff can see the Udyam evidence in the verification record.
 */
export async function setMsmeDeclaration(businessId: string, category: MsmeCategory | null): Promise<MsmeStatus> {
  if (category !== null && !isMsmeCategory(category)) throw new DomainError("validation", "Choose micro, small or medium.");
  await prisma.$transaction(async (tx) => {
    const b = await tx.business.findUnique({ where: { id: businessId }, select: { id: true, isSeller: true, udyam: true, msmeCategory: true } });
    if (!b) throw new DomainError("not_found", "Business not found");
    if (!b.isSeller) throw new DomainError("forbidden", "Only sellers can declare an MSME category.");
    if (b.msmeCategory === category) return;
    await tx.business.update({ where: { id: businessId }, data: { msmeCategory: category, msmeDeclaredAt: category ? new Date() : null } });
    await emit(tx, "BusinessMsmeDeclared", { type: "Business", id: businessId }, { businessId, category, udyamOnFile: !!b.udyam && isValidUdyam(b.udyam) });
  });
  await bustSellerCaches(businessId);
  return (await getMsmeStatus(businessId))!;
}

/** What a commercial document prints about one party. GSTIN is the full registered number (public data, printed on tax documents). */
export interface PartyProfile {
  businessId: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  /** 2-digit GST state code from the GSTIN, else from the registered address; null when unknown */
  stateCode: string | null;
  msme: MsmeStatus;
}

export async function getPartyProfiles(businessIds: string[]): Promise<Map<string, PartyProfile>> {
  const ids = [...new Set(businessIds)];
  const out = new Map<string, PartyProfile>();
  if (!ids.length) return out;
  const rows = await prisma.business.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, legalName: true, gstin: true, udyam: true, msmeCategory: true, msmeDeclaredAt: true, registeredAddress: true },
  });
  for (const b of rows) {
    const fromGstin = b.gstin && GST_STATES[b.gstin.slice(0, 2)] ? b.gstin.slice(0, 2) : null;
    const addr = (b.registeredAddress ?? null) as { stateCode?: unknown } | null;
    const fromAddr = typeof addr?.stateCode === "string" && /^\d{2}$/.test(addr.stateCode) ? addr.stateCode : null;
    out.set(b.id, {
      businessId: b.id,
      name: b.name,
      legalName: b.legalName,
      gstin: b.gstin,
      stateCode: fromGstin ?? fromAddr,
      msme: {
        businessId: b.id,
        category: isMsmeCategory(b.msmeCategory) ? b.msmeCategory : null,
        declaredAt: b.msmeDeclaredAt?.toISOString() ?? null,
        udyamOnFile: !!b.udyam && isValidUdyam(b.udyam),
        covered: msmeCovered(b.msmeCategory, b.udyam),
      },
    });
  }
  return out;
}
