import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
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
  return {
    exportedAt: new Date().toISOString(),
    person: p,
    businesses: memberships.map((m) => ({ role: m.role, ...m.business })),
    consents: consents.map((c) => ({ purpose: c.purpose, granted: c.granted, source: c.source, createdAt: c.createdAt })),
    sessions: authSessions.map((s) => ({ id: s.id, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt })),
    loginIdentities: authIdentities.map((i) => ({ provider: i.provider, email: i.email, createdAt: i.createdAt })),
  };
}

/** DPDP erasure: tombstone PII (row kept for referential integrity), revoke sessions, withdraw consents. */
export async function erasePerson(personId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
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
