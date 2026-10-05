// DPDP access right (ADR-010): everything the enquiry module holds about a person. Registered with @cnote/compliance's export
// registry. Bounded: each collection is capped (EXPORT_ROW_CAP) and flagged `truncated`.
import { EXPORT_TAKE, exportCollection, type PersonalExport, type PersonalExportContext } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string, ctx: PersonalExportContext): Promise<PersonalExport> {
  const biz = ctx.businessIds;
  const [enquiries, messages, quotes, orders, dealReports, attachments, quarantined, signals, enquiryLines, quoteLines, purchaseOrders, supplierInvoices] = await Promise.all([
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
          select: { id: true, enquiryId: true, quoteId: true, fileName: true, mimeType: true, sizeBytes: true, scannedAt: true, scanner: true, createdAt: true }, // metadata only, never the storage key
        })
      : Promise.resolve([]),
    // uploads the malware scanner blocked (metadata only: never the storage key; the bytes are deleted by retention)
    prisma.attachmentQuarantine.findMany({
      where: { uploadedByPerson: personId },
      orderBy: { detectedAt: "asc" },
      take: EXPORT_TAKE,
      select: { id: true, enquiryId: true, kind: true, fileName: true, mimeType: true, sizeBytes: true, signature: true, scanner: true, detectedAt: true, purgedAt: true },
    }),
    // ADR-002 profiling transparency: the fake-lead risk score and the coarse signals behind it (no raw IP is ever stored)
    prisma.enquirySignals.findMany({
      where: { enquiryId: { in: (await prisma.enquiry.findMany({ where: { buyerPersonId: personId }, select: { id: true }, take: EXPORT_TAKE })).map((e) => e.id) } },
      orderBy: { createdAt: "asc" },
      take: EXPORT_TAKE,
      select: { enquiryId: true, uaFamily: true, velocityPerson1h: true, velocityPerson24h: true, velocityIp24h: true, riskScore: true, riskReasons: true, label: true, createdAt: true },
    }),
    // bill-of-materials lines on the person's requirements
    prisma.enquiryLine.findMany({ where: { enquiry: { buyerPersonId: personId } }, orderBy: [{ enquiryId: "asc" }, { ordinal: "asc" }], take: EXPORT_TAKE }),
    // per-line prices the person's businesses quoted
    biz.length ? prisma.quoteLine.findMany({ where: { quote: { sellerBusinessId: { in: biz } } }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE }) : Promise.resolve([]),
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
  ]);
  return {
    enquiries: exportCollection(enquiries),
    messages: exportCollection(messages),
    quotes: exportCollection(quotes),
    orders: exportCollection(orders),
    dealReports: exportCollection(dealReports),
    attachments: exportCollection(attachments),
    quarantinedAttachments: exportCollection(quarantined),
    fakeLeadSignals: exportCollection(signals),
    enquiryLines: exportCollection(enquiryLines),
    quoteLines: exportCollection(quoteLines),
    purchaseOrders: exportCollection(purchaseOrders),
    supplierInvoices: exportCollection(supplierInvoices),
  };
}
