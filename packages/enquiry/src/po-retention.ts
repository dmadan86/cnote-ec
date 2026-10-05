// Retention (ADR-010, DPDP s.8(7) storage limitation) for purchase-order and supplier-invoice DOCUMENTS. The monetary rows, numbers,
// versions and invoice records are commercial/tax records and stay (GST record keeping, Income Tax Act, limitation periods); what
// is purged after the window is the personal data inside them: the delivery contact name and phone in the address snapshot, and the
// stored document files (PO PDFs, uploaded supplier-invoice copies). Called by @cnote/compliance's RetentionPolicy registry.
//
// This is the one sanctioned edit of a "never edited" PO version: it only blanks the contact fields, flags the snapshot `scrubbed`,
// and drops the PDF key (the sha256 stays as evidence that a document existed).
import { prisma } from "@cnote/db";
import { getMediaStore } from "@cnote/media";

const BATCH = 200;

/**
 * Purges documents of CLOSED purchase orders (cancelled, or whose order is completed/cancelled) and settled supplier invoices
 * (paid or withdrawn) created before `before`. Idempotent. `dryRun` only counts. Returns rows affected.
 */
export async function purgePurchaseOrderDocuments(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const store = getMediaStore("private");
  let affected = 0;

  let after: string | undefined;
  for (;;) {
    const versions = await prisma.purchaseOrderVersion.findMany({
      where: {
        createdAt: { lt: before },
        purchaseOrder: { OR: [{ status: "cancelled" }, { order: { status: { in: ["completed", "cancelled"] } } }] },
      },
      select: { id: true, pdfKey: true, deliveryAddress: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (versions.length === 0) break;
    after = versions[versions.length - 1]!.id;
    for (const v of versions) {
      const addr = (v.deliveryAddress ?? {}) as Record<string, unknown>;
      if (!v.pdfKey && addr.scrubbed === true) continue;
      affected++;
      if (opts.dryRun) continue;
      if (v.pdfKey) await store.delete(v.pdfKey).catch(() => undefined);
      await prisma.purchaseOrderVersion.update({ where: { id: v.id }, data: { pdfKey: null, deliveryAddress: { ...addr, contactName: null, phone: null, scrubbed: true } } });
    }
    if (versions.length < BATCH) break;
  }

  after = undefined;
  for (;;) {
    const invoices: { id: string; fileKey: string | null }[] = await prisma.supplierInvoice.findMany({
      where: { createdAt: { lt: before }, status: { in: ["paid", "void"] }, fileKey: { not: null } },
      select: { id: true, fileKey: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (invoices.length === 0) break;
    after = invoices[invoices.length - 1]!.id;
    for (const i of invoices) {
      affected++;
      if (opts.dryRun) continue;
      await store.delete(i.fileKey!).catch(() => undefined);
      await prisma.supplierInvoice.update({ where: { id: i.id }, data: { fileKey: null, fileName: null, fileMime: null, fileSize: null } });
    }
    if (invoices.length < BATCH) break;
  }
  return affected;
}
