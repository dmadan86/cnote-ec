// DPDP access right (ADR-010): sample requests the person made, answered or evaluated. Registered with @cnote/compliance's export registry.
// Private media keys are never exported (photos are served through authorised routes); ship-to details and notes are.
import { EXPORT_TAKE, exportCollection, type PersonalExport, type PersonalExportContext } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string, ctx: PersonalExportContext): Promise<PersonalExport> {
  const biz = ctx.businessIds;
  const rows = await prisma.sampleRequest.findMany({
    where: { OR: [{ buyerPersonId: personId }, { respondedByPersonId: personId }, { evaluatedByPersonId: personId }, ...(biz.length ? [{ sellerBusinessId: { in: biz } }] : [])] },
    orderBy: { createdAt: "asc" },
    take: EXPORT_TAKE,
    select: {
      id: true, buyerPersonId: true, buyerBusinessId: true, sellerBusinessId: true, listingId: true, subject: true, quantity: true, unit: true, buyerNote: true, status: true,
      shipName: true, shipPhone: true, shipLine1: true, shipLine2: true, shipCity: true, shipPincode: true,
      amountPaise: true, adjustableAgainstBulk: true, paymentNote: true, paymentReceivedAt: true, respondBy: true, respondedAt: true, declineReason: true, declineNote: true,
      courier: true, trackingRef: true, dispatchedAt: true, deliveredAt: true, evaluatedAt: true, evaluationReasons: true, evaluationNotes: true, createdAt: true,
    },
  });
  // Seller-side rows (matched via the seller business, not as the buyer) must not hand the buyer's personal data to the exporter:
  // ship-to details and the buyer's note are blanked, whether or not the request was accepted.
  const items = rows.map(({ buyerPersonId, ...r }) => {
    const mine = buyerPersonId === personId;
    return {
      ...r,
      amountPaise: Number(r.amountPaise),
      ...(mine ? {} : { shipName: null, shipPhone: null, shipLine1: null, shipLine2: null, shipCity: null, shipPincode: null, buyerNote: null }),
    };
  });
  return { sampleRequests: exportCollection(items) };
}
