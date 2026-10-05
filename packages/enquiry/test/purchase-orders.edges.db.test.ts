// Purchase orders and supplier invoices: validation, guard and read-path edges (complements purchase-orders.db.test.ts).
import { prisma } from "@cnote/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "po-edge-media-"));
process.env.PURCHASE_ORDERS_ENABLED = "true";

const lib = await import("../src");
const identity = await import("@cnote/identity");
const { getMediaStore } = await import("@cnote/media");

type Actor = { personId: string; businessId: string };
const tag = `poe-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
const orderIds: string[] = [];
let uid = 0;

const gstin = (state: string) => `${state}${Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join("")}${String(Math.floor(Math.random() * 9000) + 1000)}F1Z5`;
const udyam = () => `UDYAM-KA-01-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const today = () => lib.istDate(new Date());

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
async function deal(opts: { msme?: boolean; leadTimeDays?: number | null } = {}) {
  const buyer = await party("buyer", { gstin: gstin("29") });
  const seller = await party("seller", { gstin: gstin("29"), udyam: opts.msme ? udyam() : undefined, isSeller: true });
  if (opts.msme) await identity.setMsmeDeclaration(seller.businessId, "small");
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Corrugated boxes", requirement: "Need boxes" } });
  enquiryIds.push(e.id);
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
  matchIds.push(m.id);
  const c = await prisma.conversation.create({ data: { matchId: m.id } });
  const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: seller.businessId, pricePaise: 25_000n, quantity: 100, unit: "pcs", paymentTerms: "net_30", gstIncluded: false, leadTimeDays: opts.leadTimeDays === undefined ? 7 : opts.leadTimeDays } });
  const o = await lib.recordOrderFromDeal(buyer, m.id, { quoteId: q.id });
  const address = await addr(buyer.businessId);
  return { buyer, seller, orderId: o.id, addressId: address.id };
}
/** An order with no quantity/price/quote (nothing to derive a PO line from). */
async function bareOrder(buyer: Actor, seller: Actor, extra: Record<string, unknown> = {}) {
  const o = await prisma.order.create({ data: { buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, ...extra } });
  orderIds.push(o.id);
  return o;
}
const inv = (poId: string, n: string, over: Record<string, unknown> = {}) => ({ purchaseOrderId: poId, invoiceNumber: n, invoiceDate: today(), taxablePaise: 1000, gstPaise: 180, ...over });

afterAll(async () => {
  await prisma.supplierInvoice.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrderSequence.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.order.deleteMany({ where: { OR: [{ matchId: { in: matchIds } }, { id: { in: orderIds } }] } });
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

describe("defaults and the feature flag", () => {
  it("defaultPoGstRateBps honours a valid override and falls back otherwise", () => {
    expect(lib.defaultPoGstRateBps({ PO_DEFAULT_GST_RATE_BPS: "500" } as NodeJS.ProcessEnv)).toBe(500);
    expect(lib.defaultPoGstRateBps({ PO_DEFAULT_GST_RATE_BPS: "0" } as NodeJS.ProcessEnv)).toBe(0);
    for (const bad of ["abc", "4001", "-1", "12.5"]) expect(lib.defaultPoGstRateBps({ PO_DEFAULT_GST_RATE_BPS: bad } as NodeJS.ProcessEnv)).toBe(lib.DEFAULT_PO_GST_RATE_BPS);
    expect(lib.defaultPoGstRateBps({} as NodeJS.ProcessEnv)).toBe(1800);
  });

  it("every write refuses when purchase orders are switched off, and reminders become a no-op", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    try {
      for (const off of ["0", "false", "OFF"]) {
        process.env.PURCHASE_ORDERS_ENABLED = off;
        expect(lib.purchaseOrdersEnabled()).toBe(false);
        await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, {})).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.amendPurchaseOrder(d.buyer, po.id, {})).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" })).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.cancelPurchaseOrder(d.buyer, po.id, "reason")).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.recordSupplierInvoice(d.seller, inv(po.id, "OFF-1"))).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.voidSupplierInvoice(d.seller, randomUUID(), "mistake")).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.recordInvoicePayment(d.buyer, randomUUID(), { paidOn: today(), reference: "UTR123456789" })).rejects.toMatchObject({ code: "forbidden" });
        expect(await lib.sendPayableReminders()).toBe(0);
      }
    } finally {
      process.env.PURCHASE_ORDERS_ENABLED = "true";
    }
    expect(lib.purchaseOrdersEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("reads", () => {
  it("suggests defaults for the buyer only, and resolves the PO by order for participants only", async () => {
    const d = await deal({ leadTimeDays: 5 });
    const stranger = await party("stranger");
    const s = await lib.suggestPurchaseOrder(d.buyer, d.orderId);
    expect(s).toMatchObject({ paymentTermsDays: 30, expectedDelivery: lib.addDays(today(), 5), gstPercent: 18, line: { description: "Corrugated boxes", quantity: 100, unit: "pcs", unitPricePaise: 25_000, priceIncludesGst: false } });
    expect(await lib.suggestPurchaseOrder(d.seller, d.orderId)).toBeNull();
    expect(await lib.suggestPurchaseOrder(d.buyer, "nope")).toBeNull();
    expect(await lib.suggestPurchaseOrder(d.buyer, randomUUID())).toBeNull();

    const bare = await bareOrder(d.buyer, d.seller);
    expect(await lib.suggestPurchaseOrder(d.buyer, bare.id)).toMatchObject({ paymentTermsDays: null, expectedDelivery: null, line: null });
    await expect(lib.issuePurchaseOrder(d.buyer, bare.id, { addressId: d.addressId, paymentTermsDays: 10 })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/no quantity/i) });

    expect(await lib.getPurchaseOrderForOrder(d.buyer, d.orderId)).toBeNull();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    expect((await lib.getPurchaseOrderForOrder(d.seller, d.orderId))?.role).toBe("seller");
    expect((await lib.getPurchaseOrderForOrder(d.buyer, d.orderId))?.id).toBe(po.id);
    expect(await lib.getPurchaseOrderForOrder(stranger, d.orderId)).toBeNull();
    expect(await lib.getPurchaseOrderForOrder(d.buyer, "x")).toBeNull();
    expect(await lib.getPurchaseOrder(stranger, po.id)).toBeNull();
    expect(await lib.getPurchaseOrder(d.buyer, "x")).toBeNull();

    const sums = await lib.purchaseOrderSummaries(d.seller, [d.orderId, "bad", randomUUID()]);
    expect(sums.get(d.orderId)).toEqual({ number: po.number, status: "issued" });
    expect(sums.size).toBe(1);
    expect((await lib.purchaseOrderSummaries(stranger, [d.orderId])).size).toBe(0);
    expect((await lib.purchaseOrderSummaries(stranger, ["bad"])).size).toBe(0);

    expect(await lib.getPurchaseOrderParties(po.id)).toMatchObject({ number: po.number, orderId: d.orderId, buyerBusinessId: d.buyer.businessId, sellerBusinessId: d.seller.businessId });
    expect(await lib.getPurchaseOrderParties("x")).toBeNull();
  });

  it("view actions follow the role and state", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    expect(po.actions).toEqual({ amend: true, cancel: true, acknowledge: false, recordInvoice: false, payInvoices: true });
    const seller = (await lib.getPurchaseOrder(d.seller, po.id))!;
    expect(seller.actions).toEqual({ amend: false, cancel: false, acknowledge: true, recordInvoice: true, payInvoices: false });
    await lib.recordSupplierInvoice(d.seller, inv(po.id, "V-1", { taxablePaise: 2_500_000, gstPaise: 450_000 }));
    const full = (await lib.getPurchaseOrder(d.seller, po.id))!;
    expect(full.actions.recordInvoice).toBe(false); // fully invoiced
    expect((await lib.getPurchaseOrder(d.buyer, po.id))!.actions.cancel).toBe(false);
  });

  it("the PDF endpoint checks id, party and version, and re-renders when the stored file is gone", async () => {
    const d = await deal();
    const stranger = await party("stranger");
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    await expect(lib.getPurchaseOrderPdf(d.buyer, "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.getPurchaseOrderPdf(stranger, po.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.getPurchaseOrderPdf(d.buyer, po.id, 9)).rejects.toMatchObject({ code: "not_found" });
    const key = `invoices/po/${po.id}/v1.pdf`;
    await getMediaStore("private").delete(key);
    const regenerated = await lib.getPurchaseOrderPdf(d.seller, po.id);
    expect(Buffer.from(regenerated.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(regenerated.filename).toMatch(/-v1\.pdf$/);
  });
});

describe("issuing edge cases", () => {
  it("rejects bad ids, missing orders, cancelled and ONDC orders, bad dates, over-long notes and bad terms", async () => {
    const d = await deal();
    await expect(lib.issuePurchaseOrder(d.buyer, "x", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.issuePurchaseOrder(d.buyer, randomUUID(), {})).rejects.toMatchObject({ code: "not_found" });
    const base = { addressId: d.addressId, paymentTermsDays: 30 };
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { ...base, expectedDelivery: "31/12/2030" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { ...base, expectedDelivery: lib.addDays(today(), -1) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/past/) });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { ...base, notes: "n".repeat(1001) })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { ...base, paymentTermsDays: -1 })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { ...base, paymentTermsDays: 1.5 })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.issuePurchaseOrder(d.buyer, d.orderId, { ...base, paymentTermsDays: lib.MAX_PAYMENT_TERMS_DAYS + 1 })).rejects.toMatchObject({ code: "validation" });

    const ondc = await bareOrder(d.buyer, d.seller, { settlement: "ondc", quantity: 1, unit: "pcs", pricePaise: 100n });
    await expect(lib.issuePurchaseOrder(d.buyer, ondc.id, base)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/ONDC/) });
    const cancelled = await bareOrder(d.buyer, d.seller, { status: "cancelled", quantity: 1, unit: "pcs", pricePaise: 100n });
    await expect(lib.issuePurchaseOrder(d.buyer, cancelled.id, base)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/cancelled/) });
  });

  it("issues several explicit lines with the given GST, and a blank note is stored as null", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, {
      addressId: d.addressId, paymentTermsDays: 0, notes: "   ", gstRateBps: 500, hsn: "4819",
      lines: [
        { description: "Boxes", quantity: 10, unit: "pcs", unitPricePaise: 10_000, gstRateBps: 1200 },
        { description: "Tape", quantity: 2, unit: "roll", unitPricePaise: 5_000, gstRateBps: 1800, priceIncludesGst: true },
      ],
    });
    expect(po.lines).toHaveLength(2);
    expect(po.notes).toBeNull();
    expect(po.paymentTermsDays).toBe(0);
    expect(po.expectedDelivery).toBe(lib.addDays(today(), 7)); // from the quote's lead time
    const e = await deal();
    const derived = await lib.issuePurchaseOrder(e.buyer, e.orderId, { addressId: e.addressId, gstRateBps: 500, hsn: "4819", expectedDelivery: lib.addDays(today(), 20) });
    expect(derived.lines[0]).toMatchObject({ gstRateBps: 500, hsn: "4819" });
    expect(derived.expectedDelivery).toBe(lib.addDays(today(), 20));
  });
});

describe("amend, answer and cancel edge cases", () => {
  it("amends lines, address, delivery date and notes; clears optional fields; blocks cancelled and under-invoiced amendments", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, notes: "first", expectedDelivery: lib.addDays(today(), 10) });
    await expect(lib.amendPurchaseOrder(d.buyer, "x", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.amendPurchaseOrder(d.buyer, randomUUID(), {})).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.amendPurchaseOrder(d.buyer, po.id, { paymentTermsDays: 9999 })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.amendPurchaseOrder(d.buyer, po.id, { expectedDelivery: "2020-01-01" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.amendPurchaseOrder(d.buyer, po.id, { addressId: randomUUID() })).rejects.toMatchObject({ code: "validation" });

    const a2 = await addr(d.buyer.businessId, "27", "Maharashtra");
    const v2 = await lib.amendPurchaseOrder(d.buyer, po.id, {
      addressId: a2.id, expectedDelivery: null, notes: null,
      lines: [{ description: "Boxes XL", quantity: 50, unit: "pcs", unitPricePaise: 30_000, gstRateBps: 1800 }],
    });
    expect(v2).toMatchObject({ currentVersion: 2, placeOfSupply: "27", intraState: false, expectedDelivery: null, notes: null });
    expect(v2.lines).toHaveLength(1);
    expect(v2.totals.igstPaise).toBeGreaterThan(0);

    // the seller invoices most of it; the buyer cannot amend below that
    await lib.recordSupplierInvoice(d.seller, inv(po.id, "AM-1", { taxablePaise: 1_000_000, gstPaise: 180_000 }));
    await expect(lib.amendPurchaseOrder(d.buyer, po.id, { lines: [{ description: "Boxes XL", quantity: 1, unit: "pcs", unitPricePaise: 1_000, gstRateBps: 1800 }] })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/already invoiced/) });

    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: "cancelled" } });
    await expect(lib.amendPurchaseOrder(d.buyer, po.id, { notes: "late" })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/cancelled/) });
  });

  it("answering: bad ids and decisions, long reasons, accepted with a reason, cancelled and strangers", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    await expect(lib.acknowledgePurchaseOrder(d.seller, "x", { decision: "accepted" })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "maybe" as never })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "rejected", reason: "r".repeat(501) })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "rejected", reason: "no" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.acknowledgePurchaseOrder(d.seller, randomUUID(), { decision: "accepted" })).rejects.toMatchObject({ code: "not_found" });
    const ok = await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted", reason: "  Happy to supply  " });
    expect(ok.versions[0]).toMatchObject({ ack: "accepted", ackReason: "Happy to supply" });
    await lib.cancelPurchaseOrder(d.buyer, po.id, "cancelled by buyer");
    await expect(lib.cancelPurchaseOrder(d.buyer, po.id, "again please")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already cancelled/) });

    const e = await deal();
    const po2 = await lib.issuePurchaseOrder(e.buyer, e.orderId, { addressId: e.addressId });
    await lib.cancelPurchaseOrder(e.buyer, po2.id, "no longer needed");
    await expect(lib.acknowledgePurchaseOrder(e.seller, po2.id, { decision: "accepted" })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/cancelled/) });
    await expect(lib.cancelPurchaseOrder(e.buyer, "x", "a valid reason")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.cancelPurchaseOrder(e.buyer, randomUUID(), "a valid reason")).rejects.toMatchObject({ code: "not_found" });
  });

  it("cancelling an order with no purchase order is a no-op, and a PO already cancelled is not cancelled twice", async () => {
    const d = await deal();
    await lib.transitionOrder(d.buyer, d.orderId, "cancelled");
    expect(await prisma.purchaseOrder.count({ where: { orderId: d.orderId } })).toBe(0);
    const e = await deal();
    const po = await lib.issuePurchaseOrder(e.buyer, e.orderId, { addressId: e.addressId });
    await lib.cancelPurchaseOrder(e.buyer, po.id, "manual cancel");
    await lib.transitionOrder(e.buyer, e.orderId, "cancelled");
    const evs = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM domain_events WHERE type = 'PurchaseOrderCancelled' AND payload->>'purchaseOrderId' = ${po.id}`;
    expect(Number(evs[0]!.n)).toBe(1);
  });
});

describe("supplier invoice validation", () => {
  it("rejects bad ids, dates, amounts and e-invoice / e-way fields", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const rec = (over: Record<string, unknown>) => lib.recordSupplierInvoice(d.seller, inv(po.id, `Z-${++uid}`, over) as never);
    await expect(lib.recordSupplierInvoice(d.seller, inv("x", "Z-0"))).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.recordSupplierInvoice(d.seller, inv(randomUUID(), "Z-0"))).rejects.toMatchObject({ code: "not_found" });
    await expect(rec({ invoiceDate: "05-05-2026" })).rejects.toMatchObject({ code: "validation" });
    await expect(rec({ invoiceDate: lib.addDays(today(), 1) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/future/) });
    await expect(rec({ invoiceDate: lib.addDays(today(), -401) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/too old/) });
    await expect(rec({ taxablePaise: -1 })).rejects.toMatchObject({ code: "validation" });
    await expect(rec({ taxablePaise: 1.5 })).rejects.toMatchObject({ code: "validation" });
    await expect(rec({ gstPaise: 2_000_000_000_000 })).rejects.toMatchObject({ code: "validation" });
    await expect(rec({ taxablePaise: 0, gstPaise: 0 })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/above 0/) });
    await expect(rec({ ackDate: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/IRN/) });
    await expect(rec({ irn: "e".repeat(64), ackDate: "garbage" })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/acknowledgement date/) });
    await expect(rec({ ewbValidUntil: lib.addDays(today(), 3) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/e-way bill number/) });
    await expect(rec({ ewbNo: "123456789012", ewbValidUntil: "nonsense" })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/validity/) });
    await expect(rec({ ewbNo: "123456789012", ewbValidUntil: lib.addDays(today(), -5) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/cannot expire before/) });
    await expect(rec({ file: { fileName: "big.pdf", bytes: new Uint8Array(lib.MAX_INVOICE_FILE_BYTES + 1).fill(1) } })).rejects.toMatchObject({ code: "validation" });
  });

  it("accepts zone-less date-times as IST, blank optionals, an empty file object, and reports an expired e-way bill", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const a = await lib.recordSupplierInvoice(d.seller, inv(po.id, "OK-1", { irn: "  ", ackNo: " ", ackDate: "", signedQr: "", ewbNo: " ", ewbValidUntil: "", file: { fileName: "", bytes: new Uint8Array() } }) as never);
    expect(a).toMatchObject({ eInvoice: null, ewayBill: null, file: null });
    const irn = "f".repeat(64);
    const b = await lib.recordSupplierInvoice(d.seller, inv(po.id, "OK-2", { irn, ackNo: "112010000099999", ackDate: `${today()}T10:30`, ewbNo: "123456789012", ewbValidUntil: today() }) as never);
    expect(b.eInvoice).toMatchObject({ irn, hasSignedQr: false });
    expect(b.eInvoice?.ackDate).toBe(new Date(`${today()}T10:30:00+05:30`).toISOString());
    const c = await lib.recordSupplierInvoice(d.seller, inv(po.id, "OK-3", { ewbNo: "123456789013", ewbValidUntil: today() }) as never, new Date(Date.now() + 5 * 86_400_000));
    expect(c.ewayBill?.expired).toBe(true);
  });

  it("refuses the same invoice number again, and any invoice once the PO is rejected", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    await lib.recordSupplierInvoice(d.seller, inv(po.id, "DUP-1"));
    await expect(lib.recordSupplierInvoice(d.seller, inv(po.id, "DUP-1"))).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already recorded an invoice/) });
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: "rejected" } });
    await expect(lib.recordSupplierInvoice(d.seller, inv(po.id, "DUP-2"))).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/rejected/) });
  });
});

describe("voiding and payments edge cases", () => {
  it("void: ids, reason bounds, ownership, already void, system void keeps invoices with payments", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const a = await lib.recordSupplierInvoice(d.seller, inv(po.id, "VD-1"));
    await expect(lib.voidSupplierInvoice(d.seller, "x", "mistake")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.voidSupplierInvoice(d.seller, a.id, "r".repeat(301))).rejects.toMatchObject({ code: "validation" });
    await expect(lib.voidSupplierInvoice(d.buyer, a.id, "not the seller")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.voidSupplierInvoice(d.seller, randomUUID(), "not here")).rejects.toMatchObject({ code: "not_found" });
    await lib.voidSupplierInvoice(d.seller, a.id, "entered twice");
    await expect(lib.voidSupplierInvoice(d.seller, a.id, "entered twice")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/void/) });
    await expect(lib.recordInvoicePayment(d.buyer, a.id, { paidOn: today(), reference: "UTR123456789" })).rejects.toMatchObject({ code: "conflict" });

    const b = await lib.recordSupplierInvoice(d.seller, inv(po.id, "VD-2"));
    const c = await lib.recordSupplierInvoice(d.seller, inv(po.id, "VD-3"));
    await lib.recordInvoicePayment(d.buyer, b.id, { paidOn: today(), reference: "UTR555555555", amountPaise: 100 });
    await lib.transitionOrder(d.buyer, d.orderId, "cancelled");
    expect((await lib.getSupplierInvoice(d.buyer, b.id))?.status).toBe("open"); // has a payment: kept
    expect(await lib.getSupplierInvoice(d.buyer, c.id)).toMatchObject({ status: "void", voidReason: "order cancelled", outstandingPaise: 0 });
  });

  it("payment: ids, dates, amounts and ownership", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const i = await lib.recordSupplierInvoice(d.seller, inv(po.id, "PY-1", { invoiceDate: lib.addDays(today(), -3) }));
    const pay = (over: Record<string, unknown>) => lib.recordInvoicePayment(d.buyer, i.id, { paidOn: today(), reference: "UTR123456789", ...over } as never);
    await expect(lib.recordInvoicePayment(d.buyer, "x", { paidOn: today(), reference: "UTR123456789" })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.recordInvoicePayment(d.buyer, randomUUID(), { paidOn: today(), reference: "UTR123456789" })).rejects.toMatchObject({ code: "not_found" });
    await expect(pay({ paidOn: "yesterday" })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/payment date/) });
    await expect(pay({ paidOn: lib.addDays(today(), -4) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/before the invoice date/) });
    await expect(pay({ amountPaise: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(pay({ amountPaise: -5 })).rejects.toMatchObject({ code: "validation" });
    await expect(pay({ amountPaise: 1.5 })).rejects.toThrow();
    await expect(pay({ amountPaise: 1_000_000 })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/more than the outstanding/) });
  });
});

describe("delivery moves non-MSME due dates", () => {
  it("an invoice recorded before delivery is re-based to the delivery date plus the agreed days", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 20 });
    const i = await lib.recordSupplierInvoice(d.seller, inv(po.id, "DL-1", { invoiceDate: lib.addDays(today(), -5) }));
    expect(i.due).toMatchObject({ dueBasis: "invoice_date", msmeCovered: false, dueDate: lib.addDays(today(), 15) });
    await lib.confirmOrder(d.buyer, d.orderId);
    await lib.confirmOrder(d.seller, d.orderId);
    await lib.transitionOrder(d.seller, d.orderId, "dispatched");
    await lib.transitionOrder(d.buyer, d.orderId, "delivered");
    expect((await lib.getSupplierInvoice(d.seller, i.id))?.due).toMatchObject({ dueBasis: "delivery", dueDate: lib.addDays(today(), 20) });
  });
});

describe("payables listing and reminders", () => {
  it("pages open payables with a cursor, tolerates a bad cursor, and lists every non-void invoice under 'all'", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 });
    await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" });
    for (let n = 1; n <= 21; n++) await lib.recordSupplierInvoice(d.seller, inv(po.id, `PG-${String(n).padStart(2, "0")}`, { taxablePaise: 10, gstPaise: 1 }));
    const p1 = await lib.listBuyerPayables(d.buyer);
    expect(p1.items).toHaveLength(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await lib.listBuyerPayables(d.buyer, { filter: "open", cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((r) => r.id)).size).toBe(21);
    expect((await lib.listBuyerPayables(d.buyer, { cursor: "not-a-uuid" })).items).toHaveLength(20);
    const all = await lib.listBuyerPayables(d.buyer, { filter: "all" });
    expect(all.items).toHaveLength(20);
    expect(all.summary.openCount).toBe(21);
    expect(all.items[0]).toMatchObject({ purchaseOrderNumber: po.number });
  });

  it("the admin overdue view honours limit, cursor and minDaysOverdue", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 });
    await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" });
    const mk = (n: string, ago: number) => lib.recordSupplierInvoice(d.seller, inv(po.id, n, { invoiceDate: lib.addDays(today(), -ago), taxablePaise: 10, gstPaise: 1 }));
    const old = await mk("AD-1", 60); // 30-day agreement: due 30 days ago
    const recent = await mk("AD-2", 35); // due 5 days ago
    const first = await lib.listOverdueMsmePayables({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(first.totalOverdue).toBeGreaterThanOrEqual(2);
    const next = await lib.listOverdueMsmePayables({ limit: 1, cursor: first.nextCursor });
    expect(next.items[0]!.id).not.toBe(first.items[0]!.id);
    const deep = await lib.listOverdueMsmePayables({ limit: 200, minDaysOverdue: 10 });
    expect(deep.items.some((i) => i.id === old.id)).toBe(true);
    expect(deep.items.some((i) => i.id === recent.id)).toBe(false);
    expect((await lib.listOverdueMsmePayables({ limit: 0, cursor: "bad", minDaysOverdue: 0 })).items.length).toBeGreaterThanOrEqual(1);
  });

  it("reminders page through batches, skip paid invoices and never repeat a stage", async () => {
    const d = await deal({ msme: true });
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, paymentTermsDays: 30 });
    await lib.acknowledgePurchaseOrder(d.seller, po.id, { decision: "accepted" });
    const mk = (n: string) => lib.recordSupplierInvoice(d.seller, inv(po.id, n, { invoiceDate: lib.addDays(today(), -25), taxablePaise: 10, gstPaise: 1 }));
    const a = await mk("RM-1");
    await mk("RM-2");
    await mk("RM-3");
    await lib.recordInvoicePayment(d.buyer, a.id, { paidOn: today(), reference: "UTR666666666" });
    const sent = await lib.sendPayableReminders(new Date(), { batch: 1 });
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(await prisma.supplierInvoiceReminder.count({ where: { invoiceId: a.id } })).toBe(0);
    expect(await lib.sendPayableReminders(new Date(), { batch: 1 })).toBe(0);
  });
});

describe("invoice files", () => {
  it("openSupplierInvoiceFile: bad id, unknown id, an invoice without a file, a stored object that is gone", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const i = await lib.recordSupplierInvoice(d.seller, inv(po.id, "FL-1"));
    expect(await lib.openSupplierInvoiceFile(d.buyer, "x")).toBeNull();
    expect(await lib.openSupplierInvoiceFile(d.buyer, randomUUID())).toBeNull();
    expect(await lib.openSupplierInvoiceFile(d.buyer, i.id)).toBeNull();
    expect(await lib.getSupplierInvoice(d.buyer, "x")).toBeNull();
    expect(await lib.getSupplierInvoice(d.buyer, randomUUID())).toBeNull();
    const f = await lib.recordSupplierInvoice(d.seller, inv(po.id, "FL-2", { file: { fileName: "a.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 7]) } }) as never);
    const row = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } });
    await getMediaStore("private").delete(row.fileKey!);
    expect(await lib.openSupplierInvoiceFile(d.buyer, f.id)).toBeNull();
  });
});

describe("document retention", () => {
  it("tolerates a stored object that is already gone and respects the cutoff", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const i = await lib.recordSupplierInvoice(d.seller, inv(po.id, "RT-1", { file: { fileName: "r.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 5]) } }) as never);
    const row = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: i.id } });
    await getMediaStore("private").delete(row.fileKey!);
    await lib.recordInvoicePayment(d.buyer, i.id, { paidOn: today(), reference: "UTR777777777" });
    await lib.transitionOrder(d.buyer, d.orderId, "cancelled");
    const future = new Date(Date.now() + 86_400_000);
    expect(await lib.purgePurchaseOrderDocuments(future)).toBeGreaterThanOrEqual(2);
    expect((await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: i.id } })).fileKey).toBeNull();
    expect(await lib.purgePurchaseOrderDocuments(new Date(0))).toBe(0);
  });
});

describe("multi-line purchase orders and storage failures", () => {
  const two = [
    { description: "Boxes", quantity: 10, unit: "pcs", unitPricePaise: 10_000, gstRateBps: 1200 },
    { description: "Tape", quantity: 2, unit: "roll", unitPricePaise: 5_000, gstRateBps: 1800 },
  ];

  it("amending only the notes keeps every line in order; re-sending identical lines is 'nothing changed'", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId, lines: two });
    await expect(lib.amendPurchaseOrder(d.buyer, po.id, { lines: two })).rejects.toMatchObject({ message: expect.stringMatching(/nothing changed/i) });
    const v2 = await lib.amendPurchaseOrder(d.buyer, po.id, { notes: "Pack in cartons" });
    expect(v2.lines.map((l) => [l.lineNo, l.description])).toEqual([[1, "Boxes"], [2, "Tape"]]);
    expect(v2.notes).toBe("Pack in cartons");
    const pdf = await lib.getPurchaseOrderPdf(d.seller, po.id, 1);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
  });

  it("the latest acknowledgement of a version wins", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const ver = await prisma.purchaseOrderVersion.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    const t0 = Date.now();
    await prisma.purchaseOrderAck.create({ data: { versionId: ver.id, decision: "rejected", reason: "first", byPersonId: d.seller.personId, createdAt: new Date(t0 - 60_000) } });
    await prisma.purchaseOrderAck.create({ data: { versionId: ver.id, decision: "accepted", reason: null, byPersonId: d.seller.personId, createdAt: new Date(t0) } });
    const view = (await lib.getPurchaseOrder(d.buyer, po.id))!;
    expect(view.versions[0]).toMatchObject({ ack: "accepted", ackReason: null });
  });

  it("a stored PDF that cannot be read is re-rendered; one that cannot be re-stored is still served", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const store = getMediaStore("private");
    const get = vi.spyOn(store, "get").mockRejectedValue(new Error("storage down"));
    const put = vi.spyOn(store, "put").mockRejectedValue(new Error("storage down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = await lib.getPurchaseOrderPdf(d.buyer, po.id);
      expect(Buffer.from(out.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
      expect(log).toHaveBeenCalled();
    } finally {
      get.mockRestore(); put.mockRestore(); log.mockRestore();
    }
  });

  it("issuing succeeds even when the PDF cannot be stored", async () => {
    const d = await deal();
    const put = vi.spyOn(getMediaStore("private"), "put").mockRejectedValue(new Error("storage down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
      expect(po.versions[0]!.hasPdf).toBe(false);
    } finally {
      put.mockRestore(); log.mockRestore();
    }
  });

  it("retention carries on when a stored document cannot be deleted", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const i = await lib.recordSupplierInvoice(d.seller, inv(po.id, "SF-1", { file: { fileName: "s.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 3]) } }) as never);
    await lib.recordInvoicePayment(d.buyer, i.id, { paidOn: today(), reference: "UTR888888888" });
    await lib.transitionOrder(d.buyer, d.orderId, "cancelled");
    const del = vi.spyOn(getMediaStore("private"), "delete").mockRejectedValue(new Error("storage down"));
    try {
      expect(await lib.purgePurchaseOrderDocuments(new Date(Date.now() + 86_400_000))).toBeGreaterThanOrEqual(2);
    } finally {
      del.mockRestore();
    }
    expect((await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: i.id } })).fileKey).toBeNull();
    expect((await prisma.purchaseOrderVersion.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).pdfKey).toBeNull();
  });

  it("an invoice whose transaction fails removes the file it already stored", async () => {
    const d = await deal();
    const po = await lib.issuePurchaseOrder(d.buyer, d.orderId, { addressId: d.addressId });
    const del = vi.spyOn(getMediaStore("private"), "delete").mockRejectedValue(new Error("storage down"));
    try {
      await expect(lib.recordSupplierInvoice(d.seller, inv(po.id, "RB-1", { taxablePaise: 99_999_999, gstPaise: 0, file: { fileName: "r.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 4]) } }) as never)).rejects.toMatchObject({ code: "validation" });
      expect(del).toHaveBeenCalledTimes(1);
    } finally {
      del.mockRestore();
    }
  });
});
