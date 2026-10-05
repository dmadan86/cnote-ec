// Goods receipt notes -> three-way match -> returns -> credit notes, against the real database (docs/design/grn-returns.md).
import { prisma } from "@cnote/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "grn-media-"));
process.env.PURCHASE_ORDERS_ENABLED = "true";
process.env.RETURN_WINDOW_DAYS = "30";

const lib = await import("../src");
const identity = await import("@cnote/identity");

type Actor = { personId: string; businessId: string };
const tag = `grn-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
let uid = 0;

const gstin = (state: string) => `${state}${Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join("")}${String(Math.floor(Math.random() * 9000) + 1000)}F1Z5`;
const udyam = () => `UDYAM-KA-01-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

async function party(name: string, extra: { gstin?: string; udyam?: string; isSeller?: boolean } = {}): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label, gstin: extra.gstin ?? null, udyam: extra.udyam ?? null, isSeller: extra.isSeller ?? false } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}

/** An accepted deal (qty 100 @ Rs 250, net 30) with a PO issued and accepted, and the order confirmed by both sides. `dispatch` marks it dispatched. */
async function deal(opts: { msme?: boolean; dispatch?: boolean } = {}) {
  const buyer = await party("buyer", { gstin: gstin("29") });
  const seller = await party("seller", { gstin: gstin("29"), udyam: opts.msme ? udyam() : undefined, isSeller: true });
  if (opts.msme) await identity.setMsmeDeclaration(seller.businessId, "small");
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Corrugated boxes", requirement: "Need boxes" } });
  enquiryIds.push(e.id);
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
  matchIds.push(m.id);
  const c = await prisma.conversation.create({ data: { matchId: m.id } });
  const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: seller.businessId, pricePaise: 25_000n, quantity: 100, unit: "pcs", paymentTerms: "net_30", gstIncluded: false, leadTimeDays: 7 } });
  const o = await lib.recordOrderFromDeal(buyer, m.id, { quoteId: q.id });
  const address = await prisma.businessAddress.create({ data: { businessId: buyer.businessId, label: "Warehouse", contactName: "Ravi", phone: "9876543210", line1: "12 Industrial Area", city: "Bengaluru", state: "Karnataka", stateCode: "29", pincode: "560058", isDefault: true } });
  const po = await lib.issuePurchaseOrder(buyer, o.id, { addressId: address.id });
  await lib.acknowledgePurchaseOrder(seller, po.id, { decision: "accepted" });
  await lib.confirmOrder(buyer, o.id);
  await lib.confirmOrder(seller, o.id);
  if (opts.dispatch !== false) await lib.transitionOrder(seller, o.id, "dispatched");
  return { buyer, seller, orderId: o.id, po };
}

const events = (type: string, bizId: string) =>
  prisma.$queryRaw<{ payload: Record<string, unknown>; version: number }[]>`SELECT payload, version FROM domain_events WHERE type = ${type} AND payload->>'buyerBusinessId' = ${bizId} ORDER BY id`;
const today = () => lib.istDate(new Date());

afterAll(async () => {
  await prisma.invoiceMatchOverride.deleteMany({ where: { invoice: { buyerBusinessId: { in: bizIds } } } });
  await prisma.returnCreditNote.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.goodsReturn.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.goodsReceipt.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.documentSequence.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.buyerMatchSettings.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
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

beforeAll(() => {
  expect(lib.purchaseOrdersEnabled()).toBe(true);
});

describe("goods receipts", () => {
  it("records a partial receipt with a rejection and photos, numbers it gap-free, and confirms delivery once", async () => {
    const d = await deal({ msme: true });
    // an invoice recorded before the goods arrive uses the invoice date as the day of acceptance
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "INV-1", invoiceDate: today(), taxablePaise: 2_500_000, gstPaise: 450_000, lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 25_000 }] });
    expect(inv.hasLines).toBe(true);
    const before = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(before.dueBasis).toBe("invoice_date");

    const status = await lib.getReceivingStatus(d.buyer, d.po.id);
    expect(status).toMatchObject({ canReceive: true, qtyToleranceBps: 200 });
    expect(status!.lines[0]).toMatchObject({ orderedQty: 100, receivedQty: 0, maxReceivable: 102 });

    const grn = await lib.recordGoodsReceipt(d.buyer, {
      purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi Kumar", deliveryNoteRef: "LR-778",
      lines: [{ poLineNo: 1, receivedQty: 60, rejectedQty: 10, rejectReason: "damaged", rejectNote: "wet cartons" }],
      photos: [{ fileName: "box.jpg", bytes: JPG, poLineNo: 1 }],
    });
    expect(grn.number).toMatch(/^GRN\/\d{2}-\d{2}\/000001$/);
    expect(grn).toMatchObject({ confirmedDelivery: true, acceptedUnits: 50, rejectedUnits: 10, receiverName: "Ravi Kumar" });
    expect(grn.lines[0]).toMatchObject({ receivedQty: 60, acceptedQty: 50, rejectedQty: 10, rejectReason: "damaged", unitPricePaise: 25_000 });
    expect(grn.photos).toHaveLength(1);
    expect(grn.returnWindow).toMatchObject({ open: true, daysLeft: 30 });

    // delivery was confirmed by the receipt: order delivered, deliveredAt set, the open invoice moved to the delivery date
    const order = await prisma.order.findUniqueOrThrow({ where: { id: d.orderId } });
    expect(order.status).toBe("delivered");
    expect(order.deliveredAt).not.toBeNull();
    const after = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.dueBasis).toBe("delivery");

    // the second partial receipt does not confirm delivery again and keeps the same deliveredAt
    const grn2 = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi Kumar", lines: [{ poLineNo: 1, receivedQty: 40 }] });
    expect(grn2.number).toMatch(/000002$/);
    expect(grn2.confirmedDelivery).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: d.orderId } })).deliveredAt).toEqual(order.deliveredAt);

    // over-delivery is capped at ordered + tolerance (2): 100 already received, 2 more are fine, 3 are not
    await expect(lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 3 }] })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/only 2 more/) });
    await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 2 }] });

    const ev = await events("GoodsReceiptRecorded", d.buyer.businessId);
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ version: 1, payload: { goodsReceiptId: grn.id, acceptedUnits: 50, rejectedUnits: 10, deliveryConfirmed: true } });
    expect(ev[1]!.payload.deliveryConfirmed).toBe(false);
    // the delivery confirmation is the single OrderStatusChanged to delivered
    const changes = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM domain_events WHERE type = 'OrderStatusChanged' AND payload->>'orderId' = ${d.orderId} AND payload->>'to' = 'delivered'`;
    expect(Number(changes[0]!.n)).toBe(1);
  });

  it("is limited to the buyer, a dispatched order and valid input; both sides can read it; photos are served to the two parties only", async () => {
    const early = await deal({ dispatch: false });
    await expect(lib.recordGoodsReceipt(early.buyer, { purchaseOrderId: early.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/dispatched/) });
    expect((await lib.getReceivingStatus(early.buyer, early.po.id))!.canReceive).toBe(false);

    const d = await deal();
    const base = { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi" };
    await expect(lib.recordGoodsReceipt(d.seller, { ...base, lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, lines: [] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, lines: [{ poLineNo: 1, receivedQty: 0 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, lines: [{ poLineNo: 9, receivedQty: 1 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, lines: [{ poLineNo: 1, receivedQty: 2 }, { poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, lines: [{ poLineNo: 1, receivedQty: 5, rejectedQty: 1 }] })).rejects.toMatchObject({ message: expect.stringMatching(/reason/) });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, receivedOn: lib.addDays(today(), 1), lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ message: expect.stringMatching(/future/) });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, lines: [{ poLineNo: 1, receivedQty: 1 }], photos: [{ fileName: "x.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]) }] })).rejects.toMatchObject({ message: expect.stringMatching(/JPG or PNG/) });
    await expect(lib.recordGoodsReceipt(d.buyer, { ...base, lines: [{ poLineNo: 1, receivedQty: 1 }], photos: [{ fileName: "x.jpg", bytes: new Uint8Array([1, 2, 3]) }] })).rejects.toMatchObject({ code: "validation" });
    expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: d.po.id } })).toBe(0);
    // a rejected attempt consumed no number
    const g = await lib.recordGoodsReceipt(d.buyer, { ...base, lines: [{ poLineNo: 1, receivedQty: 5 }], photos: [{ fileName: "ok.jpg", bytes: JPG }] });
    expect(g.number.endsWith("/000001")).toBe(true);

    expect(await lib.getGoodsReceipt(d.seller, g.id)).toMatchObject({ id: g.id });
    expect(await lib.getGoodsReceipt(await party("stranger"), g.id)).toBeNull();
    expect((await lib.listGoodsReceiptsForOrder(d.seller, d.orderId)).map((r) => r.id)).toEqual([g.id]);
    const photo = await lib.openGoodsReceiptPhoto(d.seller, g.photos[0]!.id);
    expect(photo?.mimeType).toBe("image/jpeg");
    expect(await lib.openGoodsReceiptPhoto(await party("stranger2"), g.photos[0]!.id)).toBeNull();
    expect(await lib.openGoodsReceiptPhoto(d.buyer, "nope")).toBeNull();
  });

  it("a manual delivery confirmation first means the receipt does not double count the acceptance", async () => {
    const d = await deal();
    await lib.transitionOrder(d.buyer, d.orderId, "delivered");
    const at = (await prisma.order.findUniqueOrThrow({ where: { id: d.orderId } })).deliveredAt;
    const g = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 10 }] });
    expect(g.confirmedDelivery).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: d.orderId } })).deliveredAt).toEqual(at);
  });
});

describe("three-way match", () => {
  it("blocks mark-paid on a mismatch until the buyer overrides with a logged reason; tolerances are per buyer", async () => {
    const d = await deal();
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "M-1", invoiceDate: today(), taxablePaise: 2_500_000, gstPaise: 450_000, lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 25_000 }] });

    // no receipt yet: pending, not blocking by default
    let m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m).toMatchObject({ receiptCount: 0, overall: "pending_grn", role: "buyer" });
    expect(m.invoices[0]).toMatchObject({ status: "pending_grn", gate: { blocked: false } });
    await lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 200, priceToleranceBps: 100, blockPendingGrn: true });
    m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m.invoices[0]!.gate).toEqual({ blocked: true, reason: "pending_grn" });
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR111111111" })).rejects.toMatchObject({ code: "conflict", details: { matchBlocked: "pending_grn" } });
    await lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 200, priceToleranceBps: 100, blockPendingGrn: false });

    // 90 of 100 accepted, 10 rejected: the seller billed all 100 => mismatch
    await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 100, rejectedQty: 10, rejectReason: "quality_fail" }] });
    m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m.overall).toBe("mismatch");
    expect(m.invoices[0]!.lines[0]).toMatchObject({ acceptedQty: 90, billedQty: 100, qtyStatus: "mismatch", priceStatus: "matched" });
    expect(m.lines[0]).toMatchObject({ orderedQty: 100, receivedQty: 100, acceptedQty: 90, rejectedQty: 10, billedQty: 100 });
    // the seller sees the status too, but not the gate or override reasons
    const sm = (await lib.getPurchaseOrderMatch(d.seller, d.po.id))!;
    expect(sm).toMatchObject({ role: "seller", overall: "mismatch" });
    expect(sm.invoices[0]).toMatchObject({ gate: null, overrides: [] });
    expect(await lib.getPurchaseOrderMatch(await party("stranger3"), d.po.id)).toBeNull();

    const pay = { paidOn: today(), amountPaise: 100_000 };
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { ...pay, reference: "UTR222222222" })).rejects.toMatchObject({ code: "conflict", details: { matchBlocked: "mismatch" }, message: expect.stringMatching(/does not match/) });
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { ...pay, reference: "UTR222222222", overrideReason: "no" })).rejects.toMatchObject({ code: "validation" });
    expect(await prisma.supplierInvoicePayment.count({ where: { invoiceId: inv.id } })).toBe(0);

    const paid = await lib.recordInvoicePayment(d.buyer, inv.id, { ...pay, reference: "UTR222222222", overrideReason: "Seller will issue a credit note next week" });
    expect(paid.paidPaise).toBe(100_000);
    const ov = await prisma.invoiceMatchOverride.findMany({ where: { invoiceId: inv.id } });
    expect(ov).toHaveLength(1);
    expect(ov[0]).toMatchObject({ reason: "Seller will issue a credit note next week", byPersonId: d.buyer.personId });
    expect(ov[0]!.summary).toMatchObject({ status: "mismatch" });
    expect((await events("InvoiceMatchOverridden", d.buyer.businessId))[0]).toMatchObject({ version: 1, payload: { supplierInvoiceId: inv.id, matchStatus: "mismatch" } });

    // the same numbers stay overridden for the next payment; the buyer's view lists the override
    await lib.recordInvoicePayment(d.buyer, inv.id, { ...pay, reference: "UTR333333333" });
    expect(await prisma.invoiceMatchOverride.count({ where: { invoiceId: inv.id } })).toBe(1);
    m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m.invoices[0]!.overrides).toEqual([expect.objectContaining({ reason: "Seller will issue a credit note next week", matchedNow: true })]);

    // a further receipt changes the numbers: the old override no longer covers it
    await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1, rejectedQty: 1, rejectReason: "short" }] });
    // (received 101 <= 102; accepted still 90, but no change in billing numbers => same fingerprint)
    await lib.recordInvoicePayment(d.buyer, inv.id, { ...pay, reference: "UTR444444444" });
  });

  it("matches within tolerance, flags price differences and uses the buyer's own tolerances", async () => {
    const d = await deal();
    await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 100 }] });
    // price 1% above the PO (25,250): within the default 1% price tolerance
    const within = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "W-1", invoiceDate: today(), taxablePaise: 25_250 * 40, gstPaise: 181_800, lines: [{ poLineNo: 1, quantity: 40, unitPricePaise: 25_250 }] });
    let m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m.invoices.find((i) => i.invoiceId === within.id)).toMatchObject({ status: "within_tolerance" });
    // tighten the price tolerance to 0: now a mismatch
    await lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 200, priceToleranceBps: 0, blockPendingGrn: false });
    m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m.tolerances).toMatchObject({ priceBps: 0, custom: true });
    expect(m.invoices[0]).toMatchObject({ status: "mismatch", gate: { blocked: true, reason: "mismatch" } });
    await expect(lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 5000, priceToleranceBps: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 1, priceToleranceBps: -1 })).rejects.toMatchObject({ code: "validation" });
  });

  it("matches an amount-only invoice on its value and validates invoice line detail", async () => {
    const d = await deal();
    await expect(lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "L-1", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180, lines: [{ poLineNo: 1, quantity: 1, unitPricePaise: 999 }] })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/add up/) });
    await expect(lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "L-1", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180, lines: [{ poLineNo: 7, quantity: 1, unitPricePaise: 1000 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "L-1", invoiceDate: today(), taxablePaise: 2000, gstPaise: 180, lines: [{ poLineNo: 1, quantity: 1, unitPricePaise: 1000 }, { poLineNo: 1, quantity: 1, unitPricePaise: 1000 }] })).rejects.toMatchObject({ code: "validation" });
    await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 40 }] });
    const ok = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "A-1", invoiceDate: today(), taxablePaise: 1_000_000, gstPaise: 180_000 });
    expect(ok.hasLines).toBe(false);
    const big = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "A-2", invoiceDate: today(), taxablePaise: 1_500_000, gstPaise: 270_000 });
    const m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m.invoices.find((i) => i.invoiceId === ok.id)).toMatchObject({ basis: "amount", status: "matched" });
    // cumulative: 1,000,000 + 1,500,000 billed against 40 x 25,000 = 1,000,000 accepted
    expect(m.invoices.find((i) => i.invoiceId === big.id)).toMatchObject({ basis: "amount", status: "mismatch" });
  });
});

describe("returns and credit notes", () => {
  it("runs request -> approve -> ship -> received -> credit note, reduces the payable and the match, and emits versioned events", async () => {
    const d = await deal();
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "R-1", invoiceDate: today(), taxablePaise: 2_500_000, gstPaise: 450_000, lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 25_000 }] });
    const grn = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 100, rejectedQty: 10, rejectReason: "damaged" }] });
    const lineId = grn.lines[0]!.id;
    expect((await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!.overall).toBe("mismatch");

    const rb = await lib.getReturnableLines(d.buyer, grn.id);
    expect(rb).toMatchObject({ windowOpen: true });
    expect(rb!.lines[0]).toMatchObject({ rejectedReturnable: 10, acceptedReturnable: 90 });

    await expect(lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "damaged", lines: [{ receiptLineId: lineId, quantity: 11, source: "rejected" }] })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/only 10/) });
    await expect(lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "weird", lines: [{ receiptLineId: lineId, quantity: 1, source: "rejected" }] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "damaged", lines: [] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.requestReturn(d.seller, { receiptId: grn.id, reasonCode: "damaged", lines: [{ receiptLineId: lineId, quantity: 1, source: "rejected" }] })).rejects.toMatchObject({ code: "not_found" });

    const ret = await lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "damaged", note: "wet", lines: [{ receiptLineId: lineId, quantity: 10, source: "rejected" }] });
    expect(ret).toMatchObject({ status: "requested", role: "buyer", units: 10, estimatedPaise: 250_000, receiptNumber: grn.number });
    expect(ret.number).toMatch(/^RMA\/\d{2}-\d{2}\/000001$/);
    expect(ret.actions).toMatchObject({ cancel: true, approve: false, ship: false });
    // held units cannot be returned twice
    await expect(lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "damaged", lines: [{ receiptLineId: lineId, quantity: 1, source: "rejected" }] })).rejects.toMatchObject({ message: expect.stringMatching(/only 0/) });

    // role and state guards
    await expect(lib.decideReturn(d.buyer, ret.id, { decision: "approved" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(lib.recordReturnShipment(d.buyer, ret.id, { trackingRef: "LR12345" })).rejects.toMatchObject({ code: "conflict" });
    await expect(lib.decideReturn(await party("stranger4"), ret.id, { decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
    const sellerView = (await lib.getGoodsReturn(d.seller, ret.id))!;
    expect(sellerView).toMatchObject({ role: "seller" });
    expect(sellerView.actions).toMatchObject({ approve: true, reject: true, cancel: false });

    expect((await lib.decideReturn(d.seller, ret.id, { decision: "approved", note: "send it back" })).status).toBe("approved");
    await expect(lib.recordReturnShipment(d.buyer, ret.id, { trackingRef: "x" })).rejects.toMatchObject({ code: "validation" });
    const shipped = await lib.recordReturnShipment(d.buyer, ret.id, { courier: "DTDC", trackingRef: "LR-12345" });
    expect(shipped).toMatchObject({ status: "shipped", shipment: { courier: "DTDC", trackingRef: "LR-12345" } });
    expect((await lib.confirmReturnReceived(d.seller, ret.id)).status).toBe("received");

    // credit note guards
    const noteBase = { invoiceId: inv.id, number: "cn/26-27/1", noteDate: today(), taxablePaise: 250_000, gstPaise: 45_000 };
    await expect(lib.recordReturnCreditNote(d.buyer, ret.id, noteBase)).rejects.toMatchObject({ code: "forbidden" });
    await expect(lib.recordReturnCreditNote(d.seller, ret.id, { ...noteBase, invoiceId: randomUUID() })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordReturnCreditNote(d.seller, ret.id, { ...noteBase, taxablePaise: 9_999_999 })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/more than the invoice/) });
    await expect(lib.recordReturnCreditNote(d.seller, ret.id, { ...noteBase, noteDate: lib.addDays(today(), 1) })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordReturnCreditNote(d.seller, ret.id, { ...noteBase, irn: "zz" })).rejects.toMatchObject({ code: "validation" });
    expect(await lib.listCreditableInvoices(d.seller, d.po.id)).toEqual([expect.objectContaining({ id: inv.id, creditablePaise: 2_950_000 })]);

    const done = await lib.recordReturnCreditNote(d.seller, ret.id, { ...noteBase, irn: "d".repeat(64) });
    expect(done).toMatchObject({ status: "credited", creditNote: { number: "CN/26-27/1", totalPaise: 295_000, irn: "d".repeat(64) } });
    const invAfter = (await lib.getSupplierInvoice(d.buyer, inv.id))!;
    expect(invAfter).toMatchObject({ creditedPaise: 295_000, outstandingPaise: 2_655_000, status: "open", refundDuePaise: 0 });

    // the credited rejected units no longer count as billed: the invoice now matches the 90 accepted units
    const m = (await lib.getPurchaseOrderMatch(d.buyer, d.po.id))!;
    expect(m.overall).toBe("matched");
    expect(m.lines[0]).toMatchObject({ acceptedQty: 90, billedQty: 90 });

    // payments are limited by what is outstanding after the credit, and a full payment settles the invoice
    await expect(lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), amountPaise: 2_655_001, reference: "UTR555555555" })).rejects.toMatchObject({ code: "validation" });
    const settled = await lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR666666666" });
    expect(settled).toMatchObject({ status: "paid", paidPaise: 2_655_000, creditedPaise: 295_000, outstandingPaise: 0 });
    const po = (await lib.getPurchaseOrderForOrder(d.buyer, d.orderId))!;
    expect(po.amounts).toMatchObject({ creditedPaise: 295_000, outstandingPaise: 0 });

    const evs = await Promise.all(["GoodsReturnRequested", "GoodsReturnDecided", "GoodsReturnShipped", "GoodsReturnReceived", "ReturnCreditNoteRecorded"].map((t) => events(t, d.buyer.businessId)));
    expect(evs.map((e) => e.length)).toEqual([1, 1, 1, 1, 1]);
    expect(evs[4]![0]).toMatchObject({ version: 1, payload: { goodsReturnId: ret.id, supplierInvoiceId: inv.id, totalPaise: 295_000, outstandingPaise: 2_655_000, refundDuePaise: 0, hasIrn: true } });
    await expect(lib.recordReturnCreditNote(d.seller, ret.id, { ...noteBase, number: "CN2" })).rejects.toMatchObject({ code: "conflict" });
    expect((await lib.listReturnsForOrder(d.seller, d.orderId)).map((r) => r.id)).toEqual([ret.id]);
  });

  it("a credit note after the buyer already paid shows a refund due and settles an unpaid invoice that is fully credited", async () => {
    const d = await deal();
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "F-1", invoiceDate: today(), taxablePaise: 100_000, gstPaise: 18_000 });
    const grn = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 100 }] });
    await lib.recordInvoicePayment(d.buyer, inv.id, { paidOn: today(), reference: "UTR777777777" });
    const ret = await lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "wrong_spec", lines: [{ receiptLineId: grn.lines[0]!.id, quantity: 4, source: "accepted" }] });
    await lib.decideReturn(d.seller, ret.id, { decision: "approved" });
    // credit without goods being shipped back is allowed once approved
    const done = await lib.recordReturnCreditNote(d.seller, ret.id, { invoiceId: inv.id, number: "CN9", noteDate: today(), taxablePaise: 10_000, gstPaise: 1_800 });
    expect(done.status).toBe("credited");
    const v = (await lib.getSupplierInvoice(d.buyer, inv.id))!;
    expect(v).toMatchObject({ status: "paid", creditedPaise: 11_800, refundDuePaise: 11_800, outstandingPaise: 0 });
    expect((await events("ReturnCreditNoteRecorded", d.buyer.businessId))[0]!.payload).toMatchObject({ refundDuePaise: 11_800, outstandingPaise: 0 });

    // an unpaid invoice that is credited in full is settled
    const d2 = await deal();
    const inv2 = await lib.recordSupplierInvoice(d2.seller, { purchaseOrderId: d2.po.id, invoiceNumber: "F-2", invoiceDate: today(), taxablePaise: 100_000, gstPaise: 18_000 });
    const g2 = await lib.recordGoodsReceipt(d2.buyer, { purchaseOrderId: d2.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 4, rejectedQty: 4, rejectReason: "short" }] });
    const r2 = await lib.requestReturn(d2.buyer, { receiptId: g2.id, reasonCode: "short", lines: [{ receiptLineId: g2.lines[0]!.id, quantity: 4, source: "rejected" }] });
    await lib.decideReturn(d2.seller, r2.id, { decision: "approved" });
    await lib.recordReturnCreditNote(d2.seller, r2.id, { invoiceId: inv2.id, number: "CN10", noteDate: today(), taxablePaise: 100_000, gstPaise: 18_000 });
    expect(await lib.getSupplierInvoice(d2.buyer, inv2.id)).toMatchObject({ status: "paid", outstandingPaise: 0, creditedPaise: 118_000, refundDuePaise: 0 });
  });

  it("handles cancel, rejection with a reason and the dispute link; enforces the return window", async () => {
    const d = await deal();
    const grn = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 50, rejectedQty: 5, rejectReason: "wrong_spec" }] });
    const lineId = grn.lines[0]!.id;
    const a = await lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "wrong_spec", lines: [{ receiptLineId: lineId, quantity: 2, source: "rejected" }] });
    expect((await lib.cancelReturn(d.buyer, a.id)).status).toBe("cancelled");
    await expect(lib.cancelReturn(d.buyer, a.id)).rejects.toMatchObject({ code: "conflict" });
    // a cancelled return frees its units
    const b = await lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "wrong_spec", lines: [{ receiptLineId: lineId, quantity: 5, source: "rejected" }] });
    await expect(lib.decideReturn(d.seller, b.id, { decision: "rejected" })).rejects.toMatchObject({ code: "validation" });
    const rej = await lib.decideReturn(d.seller, b.id, { decision: "rejected", note: "Goods match the PO" });
    expect(rej).toMatchObject({ status: "rejected", decisionNote: "Goods match the PO" });
    expect((await lib.getGoodsReturn(d.buyer, b.id))!.actions.dispute).toBe(true);
    // a rejected return releases its units too
    expect((await lib.getReturnableLines(d.buyer, grn.id))!.lines[0]).toMatchObject({ rejectedReturnable: 5 });

    const disputeId = randomUUID();
    await expect(lib.linkReturnDispute(d.seller, b.id, disputeId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(lib.linkReturnDispute(d.buyer, b.id, "nope")).rejects.toMatchObject({ code: "validation" });
    const linked = await lib.linkReturnDispute(d.buyer, b.id, disputeId);
    expect(linked).toMatchObject({ disputeId });
    expect(linked.actions.dispute).toBe(false);
    await expect(lib.linkReturnDispute(d.buyer, b.id, randomUUID())).rejects.toMatchObject({ code: "conflict" });
    expect((await events("GoodsReturnDisputeLinked", d.buyer.businessId))[0]!.payload).toMatchObject({ disputeId });
    // not linkable unless rejected
    const c = await lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "other", lines: [{ receiptLineId: lineId, quantity: 1, source: "rejected" }] });
    await expect(lib.linkReturnDispute(d.buyer, c.id, randomUUID())).rejects.toMatchObject({ code: "conflict" });

    // the window: a receipt dated 40 days ago is outside the 30-day window
    const old = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: lib.addDays(today(), -40), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 10 }] });
    expect(old.returnWindow.open).toBe(false);
    await expect(lib.requestReturn(d.buyer, { receiptId: old.id, reasonCode: "other", lines: [{ receiptLineId: old.lines[0]!.id, quantity: 1, source: "accepted" }] })).rejects.toMatchObject({ code: "conflict", details: { returnWindowClosed: true } });

    // paging and filters
    const page = await lib.listGoodsReturns(d.seller, { role: "seller", status: "open" });
    expect(page.items.map((r) => r.id)).toEqual([c.id]);
    expect(page.counts).toEqual({ open: 1, actionNeeded: 1 });
    const buyerPage = await lib.listGoodsReturns(d.buyer, { role: "buyer" });
    expect(buyerPage.items).toHaveLength(3);
    expect(await lib.getGoodsReturn(await party("stranger5"), b.id)).toBeNull();
    expect(await lib.getGoodsReturn(d.buyer, "x")).toBeNull();
  });
});

describe("retention and export", () => {
  it("exports receipts, returns and overrides, and erases receiver names and photos of closed orders", async () => {
    const d = await deal();
    const grn = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi Kumar", lines: [{ poLineNo: 1, receivedQty: 5 }], photos: [{ fileName: "a.jpg", bytes: JPG }] });
    const exp = await lib.exportPersonalData(d.buyer.personId, { businessIds: [d.buyer.businessId] });
    const rows = (exp.goodsReceipts as { items: { number: string; receiverName: string; photos: { key?: unknown; fileName: string }[] }[] }).items;
    expect(rows[0]).toMatchObject({ number: grn.number, receiverName: "Ravi Kumar" });
    expect(rows[0]!.photos[0]!.key).toBeUndefined();
    expect(rows[0]!.photos[0]!.fileName).toBe("a.jpg");
    expect(exp).toHaveProperty("goodsReturns");
    expect(exp).toHaveProperty("invoiceMatchOverrides");

    const future = new Date(Date.now() + 86_400_000);
    expect(await lib.purgeGoodsReceiptPhotos(future, { dryRun: true })).toBe(0); // order not closed
    await lib.transitionOrder(d.buyer, d.orderId, "completed");
    expect(await lib.purgeGoodsReceiptPhotos(future, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await prisma.goodsReceiptPhoto.count({ where: { receiptId: grn.id } })).toBe(1);
    expect(await lib.purgeGoodsReceiptPhotos(future)).toBeGreaterThanOrEqual(1);
    expect(await prisma.goodsReceiptPhoto.count({ where: { receiptId: grn.id } })).toBe(0);
    const row = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: grn.id } });
    expect(row.receiverName).toBe("(erased)");
    expect(row.number).toBe(grn.number);
    expect(await lib.purgeGoodsReceiptPhotos(future)).toBe(0);
  });
});

describe("edge cases and guards", () => {
  it("receipt reads and the receiving status reject foreign, malformed and unknown ids; the feature flag turns writes off", async () => {
    const d = await deal();
    expect(await lib.getReceivingStatus(d.seller, d.po.id)).toBeNull();
    expect(await lib.getReceivingStatus(d.buyer, "x")).toBeNull();
    expect(await lib.getGoodsReceipt(d.buyer, "x")).toBeNull();
    expect(await lib.listGoodsReceiptsForOrder(d.buyer, "x")).toEqual([]);
    expect(await lib.getReturnableLines(d.buyer, "x")).toBeNull();
    expect(await lib.getReturnableLines(d.seller, randomUUID())).toBeNull();
    expect(await lib.listReturnsForOrder(d.buyer, "x")).toEqual([]);
    expect(await lib.getPurchaseOrderMatch(d.buyer, "x")).toBeNull();
    expect(await lib.listCreditableInvoices(d.seller, "x")).toEqual([]);
    await expect(lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: "x", receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }], photos: Array.from({ length: 6 }, () => ({ fileName: "a.jpg", bytes: JPG })) })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }], photos: [{ fileName: "a.jpg", bytes: JPG, poLineNo: 9 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", note: "x".repeat(501), lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "validation" });
    expect(await lib.getBuyerMatchSettings(d.buyer.businessId)).toMatchObject({ custom: false, qtyToleranceBps: 200, priceToleranceBps: 100 });

    process.env.PURCHASE_ORDERS_ENABLED = "false";
    try {
      await expect(lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "forbidden" });
      await expect(lib.requestReturn(d.buyer, { receiptId: randomUUID(), reasonCode: "other", lines: [] })).rejects.toMatchObject({ code: "forbidden" });
      await expect(lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 1, priceToleranceBps: 1 })).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      process.env.PURCHASE_ORDERS_ENABLED = "true";
    }
  });

  it("receipts on completed, rejected and cancelled POs and orders are handled", async () => {
    const d = await deal();
    await lib.transitionOrder(d.buyer, d.orderId, "delivered");
    await lib.transitionOrder(d.buyer, d.orderId, "completed");
    const g = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 3 }] });
    expect(g.confirmedDelivery).toBe(false);
    // a completed order whose delivery was never stamped (legacy row) is stamped by the receipt
    const d2 = await deal();
    await prisma.order.update({ where: { id: d2.orderId }, data: { status: "completed", deliveredAt: null } });
    const g2 = await lib.recordGoodsReceipt(d2.buyer, { purchaseOrderId: d2.po.id, receivedOn: lib.addDays(today(), -3), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 3 }] });
    expect(g2.confirmedDelivery).toBe(true);
    expect(lib.istDate((await prisma.order.findUniqueOrThrow({ where: { id: d2.orderId } })).deliveredAt!)).toBe(lib.addDays(today(), -3));
    // a rejected-only receipt (nothing accepted) does not confirm delivery
    const d3 = await deal();
    const g3 = await lib.recordGoodsReceipt(d3.buyer, { purchaseOrderId: d3.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 5, rejectedQty: 5, rejectReason: "wrong_spec" }] });
    expect(g3.confirmedDelivery).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: d3.orderId } })).deliveredAt).toBeNull();
    const d4 = await deal();
    await prisma.purchaseOrder.update({ where: { id: d4.po.id }, data: { status: "rejected" } });
    await expect(lib.recordGoodsReceipt(d4.buyer, { purchaseOrderId: d4.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/rejected/) });
    await prisma.purchaseOrder.update({ where: { id: d4.po.id }, data: { status: "cancelled" } });
    await expect(lib.recordGoodsReceipt(d4.buyer, { purchaseOrderId: d4.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ message: expect.stringMatching(/cancelled/) });
  });

  it("validates return requests and credit notes strictly", async () => {
    const d = await deal();
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "E-1", invoiceDate: today(), taxablePaise: 500_000, gstPaise: 90_000 });
    const inv2 = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "E-2", invoiceDate: today(), taxablePaise: 500_000, gstPaise: 90_000 });
    const grn = await lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 100, rejectedQty: 20, rejectReason: "damaged" }] });
    const lineId = grn.lines[0]!.id;
    const req = (lines: { receiptLineId: string; quantity: number; source: "rejected" | "accepted" }[], extra: Record<string, unknown> = {}) => lib.requestReturn(d.buyer, { receiptId: grn.id, reasonCode: "damaged", lines, ...extra });
    await expect(req([{ receiptLineId: lineId, quantity: 1, source: "rejected" }], { note: "x".repeat(501) })).rejects.toMatchObject({ code: "validation" });
    await expect(req([{ receiptLineId: "nope", quantity: 1, source: "rejected" }])).rejects.toMatchObject({ code: "validation" });
    await expect(req([{ receiptLineId: lineId, quantity: 1, source: "weird" as never }])).rejects.toMatchObject({ code: "validation" });
    await expect(req([{ receiptLineId: lineId, quantity: 1.5, source: "rejected" }])).rejects.toMatchObject({ code: "validation" });
    await expect(req([{ receiptLineId: lineId, quantity: 1, source: "rejected" }, { receiptLineId: lineId, quantity: 1, source: "rejected" }])).rejects.toMatchObject({ code: "validation" });
    await expect(req([{ receiptLineId: randomUUID(), quantity: 1, source: "rejected" }])).rejects.toMatchObject({ code: "validation" });
    await expect(lib.requestReturn(d.buyer, { receiptId: "x", reasonCode: "damaged", lines: [] })).rejects.toMatchObject({ code: "not_found" });

    const both = await req([{ receiptLineId: lineId, quantity: 20, source: "rejected" }, { receiptLineId: lineId, quantity: 5, source: "accepted" }]);
    expect(both).toMatchObject({ units: 25, estimatedPaise: 625_000 });
    await expect(lib.decideReturn(d.seller, both.id, { decision: "approved", note: "x".repeat(501) })).rejects.toMatchObject({ code: "validation" });
    await lib.decideReturn(d.seller, both.id, { decision: "approved" });
    await expect(lib.recordReturnShipment(d.buyer, both.id, { courier: "c".repeat(61), trackingRef: "LR-1234" })).rejects.toMatchObject({ code: "validation" });
    await lib.recordReturnShipment(d.buyer, both.id, { trackingRef: "LR-1234" });

    const note = { invoiceId: inv.id, number: "CN-A", noteDate: today(), taxablePaise: 100_000, gstPaise: 18_000 };
    await expect(lib.recordReturnCreditNote(d.seller, both.id, { ...note, noteDate: "nope" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordReturnCreditNote(d.seller, both.id, { ...note, noteDate: lib.addDays(today(), -5) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/before the invoice/) });
    await expect(lib.recordReturnCreditNote(d.seller, both.id, { ...note, invoiceId: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordReturnCreditNote(d.seller, both.id, { ...note, number: "bad number!" })).rejects.toMatchObject({ code: "validation" });
    await lib.voidSupplierInvoice(d.seller, inv2.id, "wrong invoice");
    await expect(lib.recordReturnCreditNote(d.seller, both.id, { ...note, invoiceId: inv2.id })).rejects.toMatchObject({ code: "conflict" });
    await lib.recordReturnCreditNote(d.seller, both.id, { ...note, irn: "e".repeat(64) });

    // a second return: the same credit note number or the same IRN is refused
    const second = await req([{ receiptLineId: lineId, quantity: 5, source: "accepted" }]);
    await lib.decideReturn(d.seller, second.id, { decision: "approved" });
    await expect(lib.recordReturnCreditNote(d.seller, second.id, { ...note, taxablePaise: 10_000, gstPaise: 0 })).rejects.toMatchObject({ code: "conflict", details: { number: expect.any(String) } });
    await expect(lib.recordReturnCreditNote(d.seller, second.id, { ...note, number: "CN-B", taxablePaise: 10_000, gstPaise: 0, irn: "e".repeat(64) })).rejects.toMatchObject({ code: "conflict", details: { irn: expect.any(String) } });
    expect((await lib.getGoodsReturn(d.buyer, second.id))!.status).toBe("approved");

    // order cancelled: no new returns
    await prisma.order.update({ where: { id: d.orderId }, data: { status: "cancelled" } });
    await expect(req([{ receiptLineId: lineId, quantity: 1, source: "accepted" }])).rejects.toMatchObject({ code: "conflict" });
  });

  it("status lookup for several POs and invoice line validation", async () => {
    const d = await deal();
    const inv = await lib.recordSupplierInvoice(d.seller, { purchaseOrderId: d.po.id, invoiceNumber: "S-1", invoiceDate: today(), taxablePaise: 1000, gstPaise: 180 });
    const map = await lib.getInvoiceMatchStatuses(d.buyer, [d.po.id, d.po.id, "x"]);
    expect(map.get(inv.id)).toMatchObject({ status: "pending_grn" });
    expect([...(await lib.getInvoiceMatchStatuses(d.seller, [d.po.id])).values()][0]!.gate).toBeNull();
    const base = { purchaseOrderId: d.po.id, invoiceNumber: "S-2", invoiceDate: today(), taxablePaise: 1000, gstPaise: 0 };
    await expect(lib.recordSupplierInvoice(d.seller, { ...base, lines: Array.from({ length: 51 }, (_, i) => ({ poLineNo: i + 1, quantity: 1, unitPricePaise: 1 })) })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordSupplierInvoice(d.seller, { ...base, lines: [{ poLineNo: 1, quantity: 0, unitPricePaise: 1000 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordSupplierInvoice(d.seller, { ...base, lines: [{ poLineNo: 1, quantity: 1, unitPricePaise: -5 }] })).rejects.toMatchObject({ code: "validation" });
  });
});
