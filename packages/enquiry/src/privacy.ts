// DPDP access right (ADR-010): everything the enquiry module holds about a person. Registered with @cnote/compliance's export
// registry. Bounded: each collection is capped (EXPORT_ROW_CAP) and flagged `truncated`.
import { EXPORT_TAKE, exportCollection, type PersonalExport, type PersonalExportContext } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string, ctx: PersonalExportContext): Promise<PersonalExport> {
  const biz = ctx.businessIds;
  const [enquiries, messages, quotes, orders, dealReports, attachments, purchaseOrders, supplierInvoices, rateContracts] = await Promise.all([
    prisma.enquiry.findMany({
      where: { buyerPersonId: personId },
      orderBy: { createdAt: "asc" },
      take: EXPORT_TAKE,
      select: {
        id: true, buyerBusinessId: true, categoryId: true, title: true, requirement: true, quantity: true, quantityUnit: true, targetPricePaise: true,
        deliveryCity: true, deliveryPincode: true, neededBy: true, language: true, status: true, budgetMinPaise: true, budgetMaxPaise: true, expiresAt: true, createdAt: true,
      },
    }),
    prisma.message.findMany({
      where: { senderPersonId: personId },
      orderBy: { createdAt: "asc" },
      take: EXPORT_TAKE,
      select: { id: true, conversationId: true, body: true, language: true, createdAt: true },
    }),
    // quotes the person received on their own requirements, and quotes their businesses sent
    prisma.quote.findMany({
      where: { OR: [{ conversation: { match: { enquiry: { buyerPersonId: personId } } } }, ...(biz.length ? [{ sellerBusinessId: { in: biz } }] : [])] },
      orderBy: { createdAt: "asc" },
      take: EXPORT_TAKE,
    }),
    biz.length
      ? prisma.order.findMany({ where: { OR: [{ buyerBusinessId: { in: biz } }, { sellerBusinessId: { in: biz } }] }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE })
      : Promise.resolve([]),
    biz.length
      ? prisma.dealReport.findMany({ where: { reportedByBusinessId: { in: biz } }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE })
      : Promise.resolve([]),
    biz.length
      ? prisma.enquiryAttachment.findMany({
          where: { uploadedByBusiness: { in: biz } },
          orderBy: { createdAt: "asc" },
          take: EXPORT_TAKE,
          select: { id: true, enquiryId: true, quoteId: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true }, // metadata only, never the storage key
        })
      : Promise.resolve([]),
    // purchase orders (docs/design/purchase-orders.md): every version with lines, parties, delivery address (contact name/phone) and the seller's answers; never storage keys
    biz.length
      ? prisma.purchaseOrder.findMany({
          where: { OR: [{ buyerBusinessId: { in: biz } }, { sellerBusinessId: { in: biz } }] },
          orderBy: { createdAt: "asc" },
          take: EXPORT_TAKE,
          include: { versions: { orderBy: { version: "asc" }, omit: { pdfKey: true }, include: { lines: { orderBy: { lineNo: "asc" } }, acks: true } } },
        })
      : Promise.resolve([]),
    // supplier invoices recorded by or against the person's businesses, with e-invoice / e-way bill references and payments
    biz.length
      ? prisma.supplierInvoice.findMany({
          where: { OR: [{ buyerBusinessId: { in: biz } }, { sellerBusinessId: { in: biz } }] },
          orderBy: { createdAt: "asc" },
          take: EXPORT_TAKE,
          omit: { fileKey: true },
          include: { payments: { orderBy: { createdAt: "asc" } } },
        })
      : Promise.resolve([]),
    // rate contracts (docs/design/rate-contracts.md): every revision with items and answers, and the call-offs placed against them
    biz.length
      ? prisma.rateContract.findMany({
          where: { OR: [{ buyerBusinessId: { in: biz } }, { sellerBusinessId: { in: biz } }] },
          orderBy: { createdAt: "asc" },
          take: EXPORT_TAKE,
          include: {
            revisions: { orderBy: { revision: "asc" }, include: { items: { orderBy: { lineNo: "asc" } }, acceptances: true } },
            callOffs: { orderBy: { callOffNo: "asc" }, include: { lines: { orderBy: { lineNo: "asc" } } } },
          },
        })
      : Promise.resolve([]),
  ]);
  return {
    enquiries: exportCollection(enquiries),
    messages: exportCollection(messages),
    quotes: exportCollection(quotes),
    orders: exportCollection(orders),
    dealReports: exportCollection(dealReports),
    attachments: exportCollection(attachments),
    purchaseOrders: exportCollection(purchaseOrders),
    supplierInvoices: exportCollection(supplierInvoices),
    rateContracts: exportCollection(rateContracts),
  };
}
