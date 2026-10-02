// Public verification evidence (ADR-003): which checks a business actually passed, with dates, for the supplier card
// and profile. Derived ONLY from VerificationRecord rows, the business's own declared names and members' phone
// verification, never from anything commercial (ADR-003). Raw identifiers are never returned: the GSTIN is masked to its
// state code + last 4 characters, and legal names are only compared, never echoed.
import { cachedManyTagged, cacheTags } from "@cnote/core";
import { prisma } from "@cnote/db";

export type VerificationCheckKey = "phone" | "gstin" | "gstin_name_match" | "udyam" | "documents" | "audit";

export interface VerificationCheck {
  key: VerificationCheckKey;
  /** the verification tier this check belongs to (0-3) */
  tier: 0 | 1 | 2 | 3;
  passed: boolean;
  /** ISO timestamp of the latest passing record, null when not passed */
  at: string | null;
}

export interface VerificationEvidence {
  businessId: string;
  tier: number;
  badgeActive: boolean;
  /** ISO timestamp the business joined the platform */
  memberSince: string;
  /** e.g. "27•••••••••A1Z5" (state code + last 4), null when no verified GSTIN is on file */
  gstinMasked: string | null;
  checks: VerificationCheck[];
}

/** State code (first 2) + last 4 characters of a GSTIN; everything between is masked. Malformed input is fully masked. */
export function maskGstin(gstin: string | null | undefined): string | null {
  const g = gstin?.trim().toUpperCase();
  if (!g) return null;
  if (g.length !== 15) return "•".repeat(Math.min(g.length, 15));
  return `${g.slice(0, 2)}${"•".repeat(9)}${g.slice(-4)}`;
}

/** Lower-case alphanumerics with common company suffixes removed, so "Acme Pvt. Ltd." matches "ACME PRIVATE LIMITED". */
export function normaliseBusinessName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(private|pvt|limited|ltd|llp|co|company|and|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/** True when the GST-registered legal name and a declared business name refer to the same entity (equal or containing). */
export function namesMatch(registered: string | null | undefined, declared: (string | null | undefined)[]): boolean {
  const r = normaliseBusinessName(registered);
  if (r.length < 3) return false;
  return declared.some((d) => {
    const n = normaliseBusinessName(d);
    return n.length >= 3 && (n === r || n.includes(r) || r.includes(n));
  });
}

export interface EvidenceInput {
  business: {
    id: string;
    name: string;
    legalName: string | null;
    tradeName: string | null;
    gstin: string | null;
    udyam: string | null;
    verificationTier: number;
    badgeActive: boolean;
    createdAt: Date;
  };
  /** verification records of the business (any order) */
  records: { kind: string; status: string; details: unknown; createdAt: Date }[];
  /** earliest phoneVerifiedAt among the business's members, null when none verified */
  phoneVerifiedAt: Date | null;
}

/** Pure derivation (unit-tested). A check passes when the NEWEST record of that kind passed (an expired audit is not passed). */
export function buildVerificationEvidence(i: EvidenceInput): VerificationEvidence {
  const latest = (kind: string) => i.records.filter((r) => r.kind === kind).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const passedAt = (kind: string): string | null => {
    const r = latest(kind);
    return r && r.status === "passed" ? r.createdAt.toISOString() : null;
  };
  const gst = latest("gstin");
  const gstPassed = gst?.status === "passed" && !!i.business.gstin;
  const legal = gstPassed ? ((gst!.details as { legalName?: unknown } | null)?.legalName as string | undefined) : undefined;
  const matched = gstPassed && namesMatch(legal, [i.business.name, i.business.legalName, i.business.tradeName]);
  const gstAt = gstPassed ? gst!.createdAt.toISOString() : null;
  const docs = passedAt("document");
  const kyc = passedAt("video_kyc");
  // T2 evidence needs both the document check and the KYC check; the date is the later of the two.
  const docsAt = docs && kyc ? (docs > kyc ? docs : kyc) : null;
  const udyamAt = i.business.udyam ? passedAt("udyam") : null;
  const auditAt = passedAt("audit");
  return {
    businessId: i.business.id,
    tier: i.business.verificationTier,
    badgeActive: i.business.badgeActive,
    memberSince: i.business.createdAt.toISOString(),
    gstinMasked: gstPassed ? maskGstin(i.business.gstin) : null,
    checks: [
      { key: "phone", tier: 0, passed: !!i.phoneVerifiedAt, at: i.phoneVerifiedAt?.toISOString() ?? null },
      { key: "gstin", tier: 1, passed: gstPassed, at: gstAt },
      { key: "gstin_name_match", tier: 1, passed: matched, at: matched ? gstAt : null },
      { key: "udyam", tier: 1, passed: !!udyamAt, at: udyamAt },
      { key: "documents", tier: 2, passed: !!docsAt, at: docsAt },
      { key: "audit", tier: 3, passed: !!auditAt, at: auditAt },
    ],
  };
}

/** Public verification evidence per business. Cached per business (10 min + SWR); BusinessVerified / profile writes purge `seller:<id>`. */
export async function getVerificationEvidence(businessIds: string[]): Promise<Map<string, VerificationEvidence>> {
  return cachedManyTagged<VerificationEvidence>(businessIds, {
    prefix: "identity:evidence:v1",
    tags: (id) => [cacheTags.seller(id)],
    ttlSeconds: 600,
    staleSeconds: 1800,
    load: async (missing) => {
      const [businesses, records, members] = await Promise.all([
        prisma.business.findMany({
          where: { id: { in: missing } },
          select: { id: true, name: true, legalName: true, tradeName: true, gstin: true, udyam: true, verificationTier: true, badgeActive: true, createdAt: true },
        }),
        prisma.verificationRecord.findMany({
          where: { businessId: { in: missing }, kind: { in: ["gstin", "udyam", "document", "video_kyc", "audit"] } },
          select: { businessId: true, kind: true, status: true, details: true, createdAt: true },
        }),
        prisma.businessMember.findMany({
          where: { businessId: { in: missing }, person: { phoneVerifiedAt: { not: null }, erasedAt: null } },
          select: { businessId: true, person: { select: { phoneVerifiedAt: true } } },
        }),
      ]);
      const out = new Map<string, VerificationEvidence>();
      for (const b of businesses) {
        const phones = members
          .filter((m) => m.businessId === b.id)
          .map((m) => m.person.phoneVerifiedAt!)
          .sort((a, c) => a.getTime() - c.getTime());
        out.set(b.id, buildVerificationEvidence({ business: b, records: records.filter((r) => r.businessId === b.id), phoneVerifiedAt: phones[0] ?? null }));
      }
      return out;
    },
  });
}
