import { prisma } from "@cnote/db";

/**
 * TEMPORARY: @cnote/identity exports no membership check yet (requested: `identity.isBusinessMember`).
 * This is the only place @cnote/developer reads BusinessMember; replace with the identity export when it lands.
 */
export async function isBusinessMember(personId: string, businessId: string): Promise<boolean> {
  const row = await prisma.businessMember.findUnique({
    where: { businessId_personId: { businessId, personId } },
    select: { personId: true },
  });
  return row !== null;
}
