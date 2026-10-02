import { emit } from "@cnote/core";
import { Prisma, prisma } from "@cnote/db";
import { revokeAllSessions } from "./sessions";
import { CONSENT_PURPOSES } from "./types";

/** DPDP access right: everything this module holds about a person (no credential hashes). */
export async function exportPersonalData(personId: string): Promise<Record<string, unknown>> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      memberships: { include: { business: true } },
      consents: { orderBy: { createdAt: "asc" } },
      authSessions: { orderBy: { createdAt: "desc" } },
      authIdentities: true,
    },
  });
  if (!person) return {};
  const { memberships, consents, authSessions, authIdentities, passwordHash, ...p } = person;
  void passwordHash;
  const businessIds = memberships.map((m) => m.businessId);
  const addresses = businessIds.length ? await prisma.businessAddress.findMany({ where: { businessId: { in: businessIds } }, orderBy: { createdAt: "asc" } }) : [];
  return {
    exportedAt: new Date().toISOString(),
    person: p,
    businesses: memberships.map((m) => ({ role: m.role, ...m.business })),
    // businesses[].gstin / legalName / pan / udyam are included above (the full Business row); addresses are listed here.
    deliveryAddresses: addresses.map(({ id, businessId, label, contactName, phone, line1, line2, city, state, pincode, isDefault, createdAt }) => ({ id, businessId, label, contactName, phone, line1, line2, city, state, pincode, isDefault, createdAt })),
    consents: consents.map((c) => ({ purpose: c.purpose, granted: c.granted, source: c.source, createdAt: c.createdAt })),
    sessions: authSessions.map((s) => ({ id: s.id, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt })),
    loginIdentities: authIdentities.map((i) => ({ provider: i.provider, email: i.email, createdAt: i.createdAt })),
  };
}

/** DPDP erasure: tombstone PII (row kept for referential integrity), revoke sessions, withdraw consents. */
export async function erasePerson(personId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Businesses this person alone belongs to: their saved addresses and (non-seller) GST identifiers go with them.
    // Seller businesses keep GSTIN/PAN: tax-invoice and trust-record retention outranks erasure (DPDP s.8(7) / ADR-010).
    const memberships = await tx.businessMember.findMany({ where: { personId }, select: { businessId: true } });
    const sole: string[] = [];
    for (const m of memberships) if ((await tx.businessMember.count({ where: { businessId: m.businessId } })) === 1) sole.push(m.businessId);
    if (sole.length) {
      await tx.businessAddress.deleteMany({ where: { businessId: { in: sole } } });
      await tx.business.updateMany({
        where: { id: { in: sole }, isSeller: false },
        data: { gstin: null, udyam: null, pan: null, legalName: null, tradeName: null, cin: null, registeredAddress: Prisma.JsonNull, gstStatus: null, gstVerifiedAt: null, gstLastCheckedAt: null, verificationTier: 0, badgeActive: false },
      });
    }
    await tx.person.update({
      where: { id: personId },
      data: { email: null, emailVerifiedAt: null, phone: null, phoneVerifiedAt: null, name: null, avatarUrl: null, passwordHash: null, erasedAt: new Date() },
    });
    await tx.authIdentity.deleteMany({ where: { personId } });
    await tx.personMfa.deleteMany({ where: { personId } });
    await tx.consent.createMany({ data: CONSENT_PURPOSES.map((purpose) => ({ personId, purpose, granted: false, source: "erasure" })) });
    await emit(tx, "DataErasureRequested", { type: "Person", id: personId }, { personId });
  });
  await revokeAllSessions(personId);
}
