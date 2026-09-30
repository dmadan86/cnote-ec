// System read for notifiers (no actor): which business an application belongs to.
import { prisma } from "@cnote/db";

export async function getCreditApplicationBusiness(applicationId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) return null;
  return (await prisma.creditApplication.findUnique({ where: { id: applicationId }, select: { businessId: true } }))?.businessId ?? null;
}
