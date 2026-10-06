// Goods receipts, three-way match settings and returns: validation, listing and storage edges (complements grn-returns.db.test.ts).
import { prisma } from "@cnote/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "grne-media-"));
process.env.PURCHASE_ORDERS_ENABLED = "true";
process.env.RETURN_WINDOW_DAYS = "30";

const lib = await import("../src");
const { getMediaStore } = await import("@cnote/media");

type Actor = { personId: string; businessId: string };
const tag = `grne-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
let uid = 0;

const gstin = (state: string) => `${state}${Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join("")}${String(Math.floor(Math.random() * 9000) + 1000)}F1Z5`;
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const today = () => lib.istDate(new Date());

async function party(name: string, isSeller = false): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label, gstin: gstin("29"), isSeller } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}
async function deal() {
  const buyer = await party("buyer");
  const seller = await party("seller", true);
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
  await lib.transitionOrder(seller, o.id, "dispatched");
  return { buyer, seller, orderId: o.id, po };
}
const receive = (d: Awaited<ReturnType<typeof deal>>, over: Record<string, unknown> = {}) =>
  lib.recordGoodsReceipt(d.buyer, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 100, rejectedQty: 10, rejectReason: "damaged" }], ...over } as never);

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

describe("goods receipt input", () => {
  it("needs at least one received line, rejects repeated lines, and over-receiving says how much room is left", async () => {
    const d = await deal();
    await expect(receive(d, { lines: undefined })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/at least one line/) });
    await expect(receive(d, { lines: [{ poLineNo: 1, receivedQty: 0 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(receive(d, { lines: [{ poLineNo: 1, receivedQty: 5 }, { poLineNo: 1, receivedQty: 5 }] })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/once/) });
    await expect(receive(d, { lines: [{ poLineNo: 1, receivedQty: 500 }] })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/only 102 more pcs/) });
    await expect(receive(d, { lines: [{ poLineNo: 7, receivedQty: 1 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(receive(d, { photos: [{ fileName: "doc.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]) }] })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/JPG or PNG/) });
    const stranger = await party("stranger");
    await expect(lib.recordGoodsReceipt(stranger, { purchaseOrderId: d.po.id, receivedOn: today(), receiverName: "Ravi", lines: [{ poLineNo: 1, receivedQty: 1 }] })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a cancelled order cannot receive goods and the status view says why", async () => {
    const d = await deal();
    await prisma.order.update({ where: { id: d.orderId }, data: { status: "cancelled" } });
    await expect(receive(d)).rejects.toMatchObject({ code: "conflict" });
    const status = (await lib.getReceivingStatus(d.buyer, d.po.id))!;
    expect(status.canReceive).toBe(false);
  });

  it("an empty photo slot is ignored; a receipt with no photos is fine", async () => {
    const d = await deal();
    const g = await receive(d, { lines: [{ poLineNo: 1, receivedQty: 10 }], photos: [{ fileName: "", bytes: new Uint8Array() }] });
    expect(g.photos).toEqual([]);
    expect(await lib.listGoodsReceiptsForOrder(d.seller, d.orderId)).toHaveLength(1);
    expect(await lib.listGoodsReceiptsForOrder(await party("x"), d.orderId)).toEqual([]);
    expect(await lib.getGoodsReceipt(await party("y"), g.id)).toBeNull();
  });
});

describe("receipt photos", () => {
  it("serves bytes, or a signed link when the store can sign; null when the object or the viewer is wrong", async () => {
    const d = await deal();
    const g = await receive(d, { photos: [{ fileName: "box.jpg", bytes: JPG, poLineNo: 1 }] });
    const photoId = g.photos[0]!.id;
    expect(await lib.openGoodsReceiptPhoto(d.buyer, "x")).toBeNull();
    expect(await lib.openGoodsReceiptPhoto(d.buyer, randomUUID())).toBeNull();
    expect(await lib.openGoodsReceiptPhoto(await party("z"), photoId)).toBeNull();
    const own = await lib.openGoodsReceiptPhoto(d.seller, photoId);
    expect(own).toMatchObject({ fileName: "box.jpg", signedUrl: null });
    expect(own!.bytes).toEqual(JPG);
    const store = getMediaStore("private");
    const sign = vi.spyOn(store, "signedGetUrl").mockResolvedValue("https://files.example.test/signed");
    try {
      expect(await lib.openGoodsReceiptPhoto(d.buyer, photoId)).toMatchObject({ signedUrl: "https://files.example.test/signed", bytes: null });
    } finally {
      sign.mockRestore();
    }
    const key = (await prisma.goodsReceiptPhoto.findUniqueOrThrow({ where: { id: photoId } })).key;
    await store.delete(key);
    expect(await lib.openGoodsReceiptPhoto(d.buyer, photoId)).toBeNull();
  });
});

describe("match settings", () => {
  it("validates tolerances and round-trips custom settings", async () => {
    const d = await deal();
    await expect(lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: -1, priceToleranceBps: 100 })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/Quantity tolerance/) });
    await expect(lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 100, priceToleranceBps: 2001 })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/Price tolerance/) });
    await expect(lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 1.5, priceToleranceBps: 100 })).rejects.toMatchObject({ code: "validation" });
    expect(await lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 0, priceToleranceBps: 50, blockPendingGrn: true })).toEqual({ qtyToleranceBps: 0, priceToleranceBps: 50, blockPendingGrn: true, custom: true });
    expect(await lib.setBuyerMatchSettings(d.buyer, { qtyToleranceBps: 300, priceToleranceBps: 50 })).toMatchObject({ blockPendingGrn: false, qtyToleranceBps: 300 });
  });

  it("the match view of a PO without invoices has no overall result; strangers and statuses lookups are empty", async () => {
    const d = await deal();
    const m = await lib.getPurchaseOrderMatch(d.buyer, d.po.id);
    expect(m?.overall ?? null).toBeNull();
    expect(await lib.getPurchaseOrderMatch(await party("s"), d.po.id)).toBeNull();
    expect(await lib.getPurchaseOrderMatch(d.buyer, randomUUID())).toBeNull();
    expect((await lib.getInvoiceMatchStatuses(d.buyer, [])).size).toBe(0);
    expect((await lib.getInvoiceMatchStatuses(d.buyer, [d.po.id, "bad"])).size).toBe(0);
  });
});

describe("returns listing and guards", () => {
  it("lists by role and status with counts, tolerates a bad cursor, and hides returns from strangers", async () => {
    const d = await deal();
    const stranger = await party("stranger");
    expect(await lib.listGoodsReturns(d.buyer, { role: "buyer" })).toEqual({ items: [], nextCursor: null, counts: { open: 0, actionNeeded: 0 } });
    const g = await receive(d);
    const lineId = g.lines[0]!.id;
    const r = await lib.requestReturn(d.buyer, { receiptId: g.id, reasonCode: "damaged", lines: [{ receiptLineId: lineId, quantity: 4, source: "rejected" }] });
    const buyerOpen = await lib.listGoodsReturns(d.buyer, { role: "buyer", status: "open", cursor: "not-a-uuid" });
    expect(buyerOpen.items.map((i) => i.id)).toEqual([r.id]);
    expect(buyerOpen.counts).toEqual({ open: 1, actionNeeded: 0 });
    const sellerView = await lib.listGoodsReturns(d.seller, { role: "seller", status: "requested" });
    expect(sellerView.items.map((i) => i.id)).toEqual([r.id]);
    expect(sellerView.counts).toEqual({ open: 1, actionNeeded: 1 });
    expect((await lib.listGoodsReturns(d.seller, { role: "seller", status: "cancelled" })).items).toEqual([]);
    expect((await lib.listGoodsReturns(stranger, { role: "buyer" })).items).toEqual([]);
    expect(await lib.getGoodsReturn(stranger, r.id)).toBeNull();
    expect(await lib.getGoodsReturn(d.buyer, "x")).toBeNull();
    expect((await lib.listReturnsForOrder(d.seller, d.orderId)).map((i) => i.id)).toEqual([r.id]);
    await lib.decideReturn(d.seller, r.id, { decision: "approved" });
    expect((await lib.listGoodsReturns(d.buyer, { role: "buyer" })).counts.actionNeeded).toBe(1);
  });

  it("a shipment needs a tracking reference, an unknown id is not found, and a malformed one too", async () => {
    const d = await deal();
    const g = await receive(d);
    const r = await lib.requestReturn(d.buyer, { receiptId: g.id, reasonCode: "damaged", lines: [{ receiptLineId: g.lines[0]!.id, quantity: 2, source: "rejected" }] });
    await lib.decideReturn(d.seller, r.id, { decision: "approved" });
    await expect(lib.recordReturnShipment(d.buyer, r.id, { trackingRef: "   " })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.recordReturnShipment(d.buyer, "x", { trackingRef: "LR-1234" })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.recordReturnShipment(d.buyer, randomUUID(), { trackingRef: "LR-1234" })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.confirmReturnReceived(d.seller, "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.cancelReturn(d.buyer, "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.decideReturn(d.seller, "x", { decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
  });
});
