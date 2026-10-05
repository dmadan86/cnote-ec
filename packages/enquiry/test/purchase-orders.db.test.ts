// Purchase orders -> supplier invoices -> MSME 43B(h) due dates -> reminders, against the real database
// (real identity module: party profiles, addresses and the MSME declaration are part of the flow).
import { prisma } from "@cnote/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "po-media-"));
process.env.PURCHASE_ORDERS_ENABLED = "true";

const lib = await import("../src");
const identity = await import("@cnote/identity");
const { confirmOrder, transitionOrder } = lib;

type Actor = { personId: string; businessId: string };
const tag = `po-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
let uid = 0;

const gstin = (state: string) => `${state}${Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join("")}${String(Math.floor(Math.random() * 9000) + 1000)}F1Z5`;
const udyam = () => `UDYAM-KA-01-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

async function party(name: string, extra: { gstin?: string; udyam?: string; isSeller?: boolean } = {}): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label, gstin: extra.gstin ?? null, udyam: extra.udyam ?? null, isSeller: extra.isSeller ?? false } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}

async function addr(businessId: string, stateCode = "29", state = "Karnataka") {
  return prisma.businessAddress.create({ data: { businessId, label: "Warehouse", contactName: "Ravi", phone: "9876543210", line1: "12 Industrial Area", city: "Bengaluru", state, stateCode, pincode: "560058", isDefault: true } });
}

/** An accepted deal with a quote, an order for it, and a seller that is (optionally) a covered MSME. */
async function deal(opts: { msme?: boolean; sellerState?: string; terms?: "net_30" | "net_15" | "advance" | "other" } = {}) {
  const buyer = await party("buyer", { gstin: gstin("29") });
  const seller = await party("seller", { gstin: gstin(opts.sellerState ?? "29"), udyam: opts.msme ? udyam() : undefined, isSeller: true });
  if (opts.msme) await identity.setMsmeDeclaration(seller.businessId, "small");
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Corrugated boxes", requirement: "Need boxes" } });
  enquiryIds.push(e.id);
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
  matchIds.push(m.id);
  const c = await prisma.conversation.create({ data: { matchId: m.id } });
  const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: seller.businessId, pricePaise: 25_000n, quantity: 100, unit: "pcs", paymentTerms: opts.terms ?? "net_30", gstIncluded: false, leadTimeDays: 7 } });
  const o = await lib.recordOrderFromDeal(buyer, m.id, { quoteId: q.id });
  const address = await addr(buyer.businessId);
  return { buyer, seller, orderId: o.id, addressId: address.id, matchId: m.id };
}

const events = (type: string, bizId: string) =>
  prisma.$queryRaw<{ payload: Record<string, unknown>; version: number }[]>`SELECT payload, version FROM domain_events WHERE type = ${type} AND payload->>'buyerBusinessId' = ${bizId} ORDER BY id`;

const irn = "c".repeat(64);
const today = () => lib.istDate(new Date());

beforeAll(() => {
  expect(lib.purchaseOrdersEnabled()).toBe(true);
});

afterAll(async () => {
  await prisma.supplierInvoice.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrderSequence.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.order.deleteMany({ where: { matchId: { in: matchIds } } });
  const convos = (await prisma.conversation.findMany({ where: { matchId: { in: matchIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.businessAddress.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE payload->>'buyerBusinessId' = ANY(${bizIds}) OR payload->>'businessId' = ANY(${bizIds})`;
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("issuing a purchase order", () => {
  it("snapshots the order's quote line, terms, parties and address; numbers it per buyer; stores an immutable PDF; emits a versioned event", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, hsn: "4819" });
    expect(po).toMatchObject({ status: "issued", currentVersion: 1, role: "buyer", paymentTermsDays: 30, placeOfSupply: "29", intraState: true });
    expect(po.number).toMatch(/^PO\/\d{2}-\d{2}\/000001$/);
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0]).toMatchObject({ lineNo: 1, description: "Corrugated boxes", hsn: "4819", quantity: 100, unit: "pcs", unitPricePaise: 25_000, gstRateBps: 1800, taxablePaise: 2_500_000, taxPaise: 450_000, totalPaise: 2_950_000 });
    expect(po.totals).toMatchObject({ cgstPaise: 225_000, sgstPaise: 225_000, igstPaise: 0, totalPaise: 2_950_000 });
    expect(po.expectedDelivery).toBe(lib.addDays(today(), 7));
    // counterparty GSTIN is masked, own GSTIN is full
    expect(po.buyer.gstin).toMatch(/^29/);
    expect(po.seller.gstin).toBeNull();
    expect(po.seller.gstinMasked).toMatch(/^29•+/);

    const v = await prisma.purchaseOrderVersion.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(v.pdfKey).toBe(`invoices/po/${po.id}/v1.pdf`);
    expect(v.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    const pdf = await lib.getPurchaseOrderPdf(d.seller, po.id);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.filename).toMatch(/^PO-\d{2}-\d{2}-000001-v1\.pdf$/);

    const ev = await events("PurchaseOrderIssued", d.buyer.businessId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ version: 1, payload: { purchaseOrderId: po.id, number: po.number, totalPaise: 2_950_000, paymentTermsDays: 30 } });
  });

  it("uses IGST for an inter-state supply, and numbers are gap-free per buyer (a rolled-back issue does not consume one)", async () => {
    const d = await deal({ sellerState: "27" });
    const po1 = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    expect(po1.totals).toMatchObject({ igstPaise: 450_000, cgstPaise: 0, sgstPaise: 0 });
    expect(po1.number.endsWith("/000001")).toBe(true);
    // second order of the same buyer, but the issue fails validation after the number was drawn? it must not leave a gap
    const o2 = await prisma.order.create({ data: { buyerBusinessId: d.buyer.businessId, sellerBusinessId: d.seller.businessId, pricePaise: 100n, quantity: 1, unit: "pcs", totalPaise: 100n } });
    await expect(lib.issuePurchaseOrder(d.buyer, o2.id, { addressId: d.addressId, paymentTermsDays: 30, lines: [{ description: "x", quantity: 1, unit: "pcs", unitPricePaise: 100, gstRateBps: 1800, hsn: "bad" }] })).rejects.toMatchObject({ code: "validation" });
    const po2 = await lib.issuePurchaseOrder(d.buyer, o2.id, { addressId: d.addressId, paymentTermsDays: 15 });
    expect(po2.number.endsWith("/000002")).toBe(true);
    await prisma.supplierInvoice.deleteMany({ where: { buyerBusinessId: d.buyer.businessId } });
  });

  it("guards: buyer only, one PO per order, address required, terms required when the quote has none, no cancelled orders", async () => {
    const d = await deal({ terms: "other" });
    await expect(lib.issuePurchaseOrder(d.seller, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { paymentTermsDays: 30 })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/payment terms/i) });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: randomUUID(), paymentTermsDays: 30 })).rejects.toMatchObject({ code: "validation" });
    await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 45 });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("amend, acknowledge, cancel", () => {
  it("an amendment adds a version, resets the answer and leaves the sent version untouched", async () => {
    const d = await deal();
    const v1 = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const acked = await lib.acknowledgePurchaseOrder(d.seller, v1.id, { decision: "accepted" });
    expect(acked.status).toBe("acknowledged");
    await expect(lib.acknowledgePurchaseOrder(d.seller, v1.id, { decision: "accepted" })).rejects.toMatchObject({ code: "conflict" });
    await expect(lib.amendPurchaseOrder(d.buyer, v1.id, {})).rejects.toMatchObject({ message: expect.stringMatching(/nothing changed/i) });
    const v2 = await lib.amendPurchaseOrder(d.buyer, v1.id, { paymentTermsDays: 45, notes: "Deliver before noon" });
    expect(v2).toMatchObject({ currentVersion: 2, status: "issued", paymentTermsDays: 45, notes: "Deliver before noon" });
    expect(v2.number).toBe(v1.number);
    expect(v2.versions.map((v) => [v.version, v.ack])).toEqual([[2, "pending"], [1, "accepted"]]);
    const stored = await prisma.purchaseOrderVersion.findFirstOrThrow({ where: { purchaseOrderId: v1.id, version: 1 } });
    expect(stored.paymentTermsDays).toBe(30);
    expect(stored.notes).toBeNull();
    expect((await events("PurchaseOrderAmended", d.buyer.businessId))[0]!.payload).toMatchObject({ version: 2, previousVersion: 1 });
    const pdf2 = await lib.getPurchaseOrderPdf(d.buyer, v1.id);
    const pdf1 = await lib.getPurchaseOrderPdf(d.buyer, v1.id, 1);
    expect(Buffer.from(pdf1.bytes).equals(Buffer.from(pdf2.bytes))).toBe(false);
    await expect(lib.amendPurchaseOrder(d.seller, v1.id, { paymentTermsDays: 5 })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejection needs a reason and the buyer can answer it with a new version", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    await expect(lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "rejected" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.acknowledgePurchaseOrder(d.buyer, po.id, { decision: "accepted" })).rejects.toMatchObject({ code: "not_found" });
    const r = await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "rejected", reason: "Price too low" });
    expect(r).toMatchObject({ status: "rejected" });
    expect(r.versions[0]).toMatchObject({ ack: "rejected", ackReason: "Price too low" });
    const again = await lib.amendPurchaseOrder(d.buyer, po.id, { paymentTermsDays: 20 });
    expect(again.status).toBe("issued");
    expect((await events("PurchaseOrderAcknowledged", d.buyer.businessId))[0]!.payload).toMatchObject({ decision: "rejected", reason: "Price too low" });
  });

  it("the buyer can cancel until the seller invoices; cancelling the order cancels the PO", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    await expect(lib.cancelPurchaseOrder(d.seller, po.id, "not allowed")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.cancelPurchaseOrder(d.buyer, po.id, "")).rejects.toMatchObject({ code: "validation" });
    const c = await lib.cancelPurchaseOrder(d.buyer, po.id, "Requirement changed");
    expect(c).toMatchObject({ status: "cancelled", cancelReason: "Requirement changed" });
    await expect(lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "A-1", invoiceDate: today(), taxablePaise: 100, gstPaise: 18 })).rejects.toMatchObject({ code: "conflict" });

    const d2 = await deal();
    const po2 = await lib.issuePurchaseOrder(d2.buyer, d2.orderId, { addressId: d2.addressId });
    await lib.recordSupplierInvoice(d2.seller, { purchaseOrderId: po2.id, invoiceNumber: "A-2", invoiceDate: today(), taxablePaise: 1_000_000, gstPaise: 180_000 });
    await expect(lib.cancelPurchaseOrder(d2.buyer, po2.id, "too late")).rejects.toMatchObject({ code: "conflict" });
    await transitionOrder(d2.buyer, d2.orderId, "cancelled");
    const after = await lib.getPurchaseOrder(d2.buyer, po2.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.invoices[0]).toMatchObject({ status: "void", voidReason: "order cancelled" });
  });
});

describe("supplier invoices, e-invoice references and the MSME due date", () => {
  it("records an invoice against the PO and reports PO vs invoiced vs outstanding; blocks over-invoicing", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "INV/26-27/001", invoiceDate: today(), taxablePaise: 1_000_000, gstPaise: 180_000 });
    expect(inv).toMatchObject({ totalPaise: 1_180_000, outstandingPaise: 1_180_000, status: "open", eInvoice: null, ewayBill: null });
    const view = await lib.getPurchaseOrder(d.buyer, po.id);
    expect(view?.amounts).toEqual({ poPaise: 2_950_000, invoicedPaise: 1_180_000, paidPaise: 0, remainingToInvoicePaise: 1_770_000, outstandingPaise: 1_180_000 });
    await expect(lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "INV/26-27/002", invoiceDate: today(), taxablePaise: 2_000_000, gstPaise: 360_000 })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/above the purchase order/i) });
    await expect(lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "INV/26-27/001", invoiceDate: today(), taxablePaise: 100, gstPaise: 18 })).rejects.toMatchObject({ code: "conflict" });
    await expect(lib.recordSupplierInvoice(d.buyer, { purchaseOrderId: po.id, invoiceNumber: "X-1", invoiceDate: today(), taxablePaise: 100, gstPaise: 18 })).rejects.toMatchObject({ code: "not_found" });
    expect((await events("SupplierInvoiceRecorded", d.buyer.businessId))[0]!.payload).toMatchObject({ invoiceNumber: "INV/26-27/001", totalPaise: 1_180_000, msmeCovered: false });
  });

  it("stores IRN / ack / signed QR / e-way bill, flags a QR that disagrees, rejects bad formats and duplicate IRNs", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const base = { purchaseOrderId: po.id, invoiceNumber: "E-1", invoiceDate: today(), taxablePaise: 1_000_000, gstPaise: 180_000 };
    await expect(lib.recordSupplierInvoice(d.seller, { ...base, irn: "short" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordSupplierInvoice(d.seller, { ...base, ewbNo: "123" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordSupplierInvoice(d.seller, { ...base, ackNo: "112010000012345" })).rejects.toMatchObject({ code: "validation" }); // ack without IRN
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = (inner: object) => `${b64({ alg: "RS256" })}.${b64({ data: JSON.stringify(inner), iss: "NIC" })}.sig`;
    const sellerGstin = (await prisma.business.findUniqueOrThrow({ where: { id: d.seller.businessId } })).gstin!;
    const good = token({ Irn: irn, DocNo: "E-1", SellerGstin: sellerGstin, DocDt: `${today().slice(8)}/${today().slice(5, 7)}/${today().slice(0, 4)}`, TotInvVal: 11800 });
    const inv = await lib.recordSupplierInvoice(d.seller, { ...base, irn: irn.toUpperCase(), ackNo: "112010000012345", ackDate: new Date().toISOString(), signedQr: good, ewbNo: "1234 5678 9012", ewbValidUntil: lib.addDays(today(), 3) });
    expect(inv.eInvoice).toMatchObject({ irn, ackNo: "112010000012345", hasSignedQr: true, check: "consistent" });
    expect(inv.ewayBill).toMatchObject({ number: "123456789012", expired: false });
    const detail = await lib.getSupplierInvoice(d.buyer, inv.id);
    expect(detail?.eInvoice?.qrDataUri?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    await expect(lib.recordSupplierInvoice(d.seller, { ...base, invoiceNumber: "E-2", irn, taxablePaise: 100, gstPaise: 18 })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/IRN/) });
    const bad = await lib.recordSupplierInvoice(d.seller, { ...base, invoiceNumber: "E-3", irn: "d".repeat(64), taxablePaise: 100, gstPaise: 18, signedQr: token({ Irn: "d".repeat(64), DocNo: "OTHER" }) });
    expect(bad.eInvoice).toMatchObject({ check: "mismatch", checkNote: "docNo" });
    expect((await events("SupplierInvoiceRecorded", d.buyer.businessId))[0]!.payload).toMatchObject({ hasIrn: true, hasEwayBill: true });
  });

  it("stores an uploaded copy privately and serves it to both parties only", async () => {
    const d = await deal();
    const stranger = await party("stranger");
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "F-1", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180, file: { fileName: "../my invoice.pdf", bytes: pdf } });
    expect(inv.file).toMatchObject({ fileName: "my invoice.pdf", mimeType: "application/pdf", sizeBytes: 8 });
    expect((await lib.openSupplierInvoiceFile(d.buyer, inv.id))?.bytes).toEqual(pdf);
    expect((await lib.openSupplierInvoiceFile(d.seller, inv.id))?.fileName).toBe("my invoice.pdf");
    expect(await lib.openSupplierInvoiceFile(stranger, inv.id)).toBeNull();
    await expect(lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "F-2", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180, file: { fileName: "x.exe", bytes: new Uint8Array([1, 2, 3]) } })).rejects.toMatchObject({ code: "validation" });
    expect(await lib.getSupplierInvoice(stranger, inv.id)).toBeNull();
  });

  it("MSME: written agreement (accepted PO) caps the period at 45 days from delivery; the invoice date is used until delivery is confirmed", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 90 });
    await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" });
    const invDate = lib.addDays(today(), -2);
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "M-1", invoiceDate: invDate, taxablePaise: 1_000_000, gstPaise: 180_000 });
    expect(inv.due).toMatchObject({ msmeCovered: true, agreementBasis: "written_agreement", agreedDays: 90, statutoryDays: 45, cappedAtStatutory: true, dueBasis: "invoice_date", acceptanceDate: invDate, dueDate: lib.addDays(invDate, 45) });
    // delivery confirmed -> the acceptance date (and the due date) move to the delivery date
    await confirmOrder(d.buyer, d.orderId);
    await confirmOrder(d.seller, d.orderId);
    await transitionOrder(d.seller, d.orderId, "dispatched");
    await transitionOrder(d.buyer, d.orderId, "delivered");
    const after = (await lib.getSupplierInvoice(d.buyer, inv.id))!;
    expect(after.due).toMatchObject({ dueBasis: "delivery", acceptanceDate: today(), dueDate: lib.addDays(today(), 45) });
    // an invoice recorded after delivery uses the delivery date straight away
    const inv2 = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "M-2", invoiceDate: today(), taxablePaise: 100_000, gstPaise: 18_000 });
    expect(inv2.due).toMatchObject({ dueBasis: "delivery", dueDate: lib.addDays(today(), 45) });
  });

  it("MSME: no written agreement (PO not accepted) means 15 days; a non-MSME seller gets the agreed terms and no statutory flag", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 });
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "N-1", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180 });
    expect(inv.due).toMatchObject({ msmeCovered: true, agreementBasis: "no_agreement", statutoryDays: 15, dueDate: lib.addDays(today(), 15) });

    const n = await deal();
    const po2 = await lib.issuePurchaseOrder(n.buyer, n.orderId, { addressId: n.addressId, paymentTermsDays: 60 });
    await lib.acknowledgePurchaseOrder(n.seller, po2.id, { decision: "accepted" });
    const inv2 = await lib.recordSupplierInvoice(n.seller, { purchaseOrderId: po2.id, invoiceNumber: "N-2", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180 });
    expect(inv2.due).toMatchObject({ msmeCovered: false, statutoryDays: null, dueDate: lib.addDays(today(), 60) });
  });

  it("a medium enterprise, or a small one without an Udyam number, is not covered", async () => {
    const seller = await party("med", { gstin: gstin("29"), udyam: udyam(), isSeller: true });
    expect((await identity.setMsmeDeclaration(seller.businessId, "medium")).covered).toBe(false);
    expect((await identity.setMsmeDeclaration(seller.businessId, "small")).covered).toBe(true);
    const noUdyam = await party("noudyam", { gstin: gstin("29"), isSeller: true });
    const st = await identity.setMsmeDeclaration(noUdyam.businessId, "micro");
    expect(st).toMatchObject({ category: "micro", udyamOnFile: false, covered: false });
    expect(await identity.setMsmeDeclaration(noUdyam.businessId, null)).toMatchObject({ category: null });
    const buyer = await party("b");
    await expect(identity.setMsmeDeclaration(buyer.businessId, "small")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("payments: part and full, late flag, UTR validation, duplicate reference, withdrawing", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 });
    await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" });
    const invDate = lib.addDays(today(), -20);
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "P-1", invoiceDate: invDate, taxablePaise: 1_000_000, gstPaise: 180_000 });
    await expect(lib.recordInvoicePayment(d.seller, inv.id, { paidOn: today(), reference: "UTR123456789" })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "12" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: lib.addDays(today(), 1), reference: "UTR123456789" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR123456789", amountPaise: 9_999_999 })).rejects.toMatchObject({ code: "validation" });
    const part = await lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: lib.addDays(today(), -1), reference: "utr123456789", amountPaise: 500_000 });
    expect(part).toMatchObject({ status: "open", paidPaise: 500_000, outstandingPaise: 680_000 });
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR123456789" })).rejects.toMatchObject({ code: "conflict" });
    await expect(lib.voidSupplierInvoice(d.seller, inv.id, "typo")).rejects.toMatchObject({ code: "conflict" });
    const full = await lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR987654321" });
    expect(full).toMatchObject({ status: "paid", outstandingPaise: 0, paidPaise: 1_180_000 });
    expect(full.due.paidLate).toBe(false); // due in 10 days, paid today
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR111111111" })).rejects.toMatchObject({ code: "conflict" });
    const evs = await events("SupplierInvoicePaymentRecorded", d.buyer.businessId);
    expect(evs.map((e) => e.payload.fullyPaid)).toEqual([false, true]);

    const late = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "P-2", invoiceDate: lib.addDays(today(), -40), taxablePaise: 100_000, gstPaise: 18_000 });
    const paidLate = await lib.recordInvoicePayment(d.buyer, late.id, { paidOn: today(), reference: "UTR222222222" });
    expect(paidLate.due.paidLate).toBe(true);
    expect(evs.length).toBe(2);

    const v = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "P-3", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180 });
    await expect(lib.voidSupplierInvoice(d.seller, v.id, "x")).rejects.toMatchObject({ code: "validation" });
    expect((await lib.voidSupplierInvoice(d.seller, v.id, "Wrong amount entered")).status).toBe("void");
    const view = await lib.getPurchaseOrder(d.seller, po.id);
    expect(view?.amounts.invoicedPaise).toBe(1_180_000 + 118_000);
  });
});

describe("payables and reminders", () => {
  it("reminds once per stage (T-7, T-1, overdue), never for paid or non-MSME invoices, and survives a re-run", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 });
    await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" });
    // acceptance 24 days ago + 30 days = due in 6 days
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "R-1", invoiceDate: lib.addDays(today(), -24), taxablePaise: 100_000, gstPaise: 18_000 });
    expect(inv.due.dueDate).toBe(lib.addDays(today(), 6));
    const at = (days: number) => new Date(Date.now() + days * 86_400_000);
    expect(await lib.sendPayableReminders(new Date())).toBeGreaterThanOrEqual(1);
    expect(await lib.sendPayableReminders(new Date())).toBe(0); // idempotent
    expect(await lib.sendPayableReminders(at(5))).toBeGreaterThanOrEqual(1); // 1 day left -> t1
    expect(await lib.sendPayableReminders(at(8))).toBeGreaterThanOrEqual(1); // overdue
    const stages = await events("SupplierInvoiceDueReminder", d.buyer.businessId);
    expect(stages.map((e) => e.payload.stage)).toEqual(["t7", "t1", "overdue"]);
    expect(stages[2]!.payload).toMatchObject({ daysOverdue: 2, outstandingPaise: 118_000, invoiceNumber: "R-1" });

    // paid invoices and non-MSME sellers get nothing
    const n = await deal();
    const po2 = await lib.issuePurchaseOrder(n.buyer, n.orderId, { addressId: n.addressId, paymentTermsDays: 0 });
    await lib.recordSupplierInvoice(n.seller, { purchaseOrderId: po2.id, invoiceNumber: "R-2", invoiceDate: lib.addDays(today(), -5), taxablePaise: 1000, gstPaise: 180 });
    await lib.sendPayableReminders(at(10));
    expect(await events("SupplierInvoiceDueReminder", n.buyer.businessId)).toHaveLength(0);
  });

  it("lists the buyer's payables soonest-due first with a summary, and the admin overdue MSME view", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 });
    await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" });
    const a = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "L-1", invoiceDate: lib.addDays(today(), -50), taxablePaise: 100_000, gstPaise: 18_000 }); // overdue
    const b = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "L-2", invoiceDate: lib.addDays(today(), -25), taxablePaise: 100_000, gstPaise: 18_000 }); // due in 5
    await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "L-3", invoiceDate: today(), taxablePaise: 100_000, gstPaise: 18_000 }); // due in 30
    const page = await lib.listBuyerPayables(d.buyer, { filter: "open" });
    expect(page.items.map((i) => i.invoiceNumber)).toEqual(["L-1", "L-2", "L-3"]);
    expect(page.summary).toMatchObject({ openCount: 3, overdueCount: 1, dueSoonCount: 1, msmeOpenCount: 3, openPaise: 354_000, overduePaise: 118_000 });
    expect(page.items[0]).toMatchObject({ purchaseOrderNumber: po.number, due: { overdue: true, daysRemaining: -20 } });
    expect((await lib.listBuyerPayables(d.buyer, { filter: "overdue" })).items.map((i) => i.invoiceNumber)).toEqual(["L-1"]);
    expect((await lib.listBuyerPayables(d.seller, { filter: "all" })).items).toHaveLength(0); // sellers see nothing as buyer
    await lib.recordInvoicePayment(d.buyer, b.id, { paidOn: today(), reference: "UTR333333333" });
    expect((await lib.listBuyerPayables(d.buyer, { filter: "paid" })).items.map((i) => i.invoiceNumber)).toEqual(["L-2"]);

    const admin = await lib.listOverdueMsmePayables({ limit: 200 });
    expect(admin.items.some((i) => i.id === a.id)).toBe(true);
    expect(admin.items.every((i) => i.due.overdue && i.due.msmeCovered)).toBe(true);
  });
});

describe("retention and export", () => {
  it("scrubs contact details and files of closed documents, keeps the monetary record, and the DPDP export carries POs and invoices", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 15 });
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: po.id, invoiceNumber: "X-1", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180, file: { fileName: "i.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9]) } });
    await lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR444444444" });

    const exp = await lib.exportPersonalData(d.seller.personId, { businessIds: [d.seller.businessId] });
    const pos = (exp.purchaseOrders as { items: { number: string; versions: { pdfKey?: unknown; deliveryAddress: { contactName: string } }[] }[] }).items;
    expect(pos.map((p) => p.number)).toContain(po.number);
    expect(pos[0]!.versions[0]!.pdfKey).toBeUndefined();
    expect(pos[0]!.versions[0]!.deliveryAddress.contactName).toBe("Ravi");
    const invs = (exp.supplierInvoices as { items: { invoiceNumber: string; fileKey?: unknown; payments: unknown[] }[] }).items;
    expect(invs[0]).toMatchObject({ invoiceNumber: "X-1" });
    expect(invs[0]!.fileKey).toBeUndefined();
    expect(invs[0]!.payments).toHaveLength(1);

    // not closed yet: nothing to purge
    const future = new Date(Date.now() + 86_400_000);
    expect(await lib.purgePurchaseOrderDocuments(future, { dryRun: true })).toBeGreaterThanOrEqual(1); // the paid invoice's file
    await transitionOrder(d.buyer, d.orderId, "cancelled");
    const n = await lib.purgePurchaseOrderDocuments(future);
    expect(n).toBeGreaterThanOrEqual(2);
    const v = await prisma.purchaseOrderVersion.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(v.pdfKey).toBeNull();
    expect(v.pdfSha256).not.toBeNull();
    expect(v.deliveryAddress).toMatchObject({ contactName: null, phone: null, scrubbed: true, city: "Bengaluru" });
    const row = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.fileKey).toBeNull();
    expect(row.totalPaise).toBe(1180n);
    expect(await lib.purgePurchaseOrderDocuments(future)).toBeLessThan(n); // idempotent for these rows
  });
});
