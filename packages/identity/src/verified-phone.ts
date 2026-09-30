// Find-or-create a Person for a phone number already verified by a trusted channel (the WhatsApp number of an
// inbound message is verified by Meta; ADR-004). Used by @cnote/whatsapp seller onboarding. No session is issued.
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { normalisePhone } from "./otp";

export async function findOrCreatePersonByVerifiedPhone(phoneInput: string): Promise<{ personId: string; isNew: boolean }> {
  const phone = normalisePhone(phoneInput);
  const attempt = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.person.findUnique({ where: { phone }, select: { id: true, erasedAt: true, phoneVerifiedAt: true } });
      if (existing) {
        if (existing.erasedAt) throw new DomainError("unauthenticated", "This account is no longer available.");
        if (!existing.phoneVerifiedAt) await tx.person.update({ where: { id: existing.id }, data: { phoneVerifiedAt: new Date() } });
        return { personId: existing.id, isNew: false };
      }
      const p = await tx.person.create({ data: { phone, phoneVerifiedAt: new Date() }, select: { id: true } });
      await emit(tx, "PersonRegistered", { type: "Person", id: p.id }, { personId: p.id, phone });
      return { personId: p.id, isNew: true };
    });
  try {
    return await attempt();
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    return attempt();
  }
}
