// DPDP access right (ADR-010): lead-capture funnel rows linked to the person (the phone is stored only as a hash).
// Registered with @cnote/compliance's export registry.
import { EXPORT_TAKE, exportCollection, type PersonalExport } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string): Promise<PersonalExport> {
  const rows = await prisma.leadCapture.findMany({
    where: { personId }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE,
    select: { id: true, trigger: true, unlock: true, listingId: true, sellerBusinessId: true, categoryId: true, enquiryId: true, status: true, followUpConsent: true, attribution: true, createdAt: true, updatedAt: true },
  });
  return { leadCaptures: exportCollection(rows) };
}
