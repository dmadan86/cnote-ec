import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listings = new Map<string, unknown>();
vi.mock("@cnote/catalogue", async (orig) => ({ ...(await orig<typeof import("@cnote/catalogue")>()), getPublicListing: async (id: string) => listings.get(id) ?? null }));

import {
  acceptLinkedQuote, acceptSample, cancelSample, countSellerPending, declineSample, dispatchSample, erasePersonSamples, evaluateSample, expireOverdueSamples, exportPersonalData,
  getBulkPrefill, getGoldenSampleForOrder, getSample, getSellerSampleStats, linkBulkEnquiry, listBuyerSamples, listSellerSamples, markSampleDelivered, purgeClosedSamplePersonalData,
  readSamplePhoto, recordSamplePayment, requestSample,
} from "../src";
import { Fixtures, JPEG, PNG, SHIP, eventsFor, installStore, type Actor } from "./helpers";

const fx = new Fixtures();
const store = installStore();
beforeAll(() => { process.env.SAMPLES_ENABLED = "true"; });
afterAll(async () => { await fx.cleanup(); delete process.env.SAMPLES_ENABLED; });
beforeEach(() => { listings.clear(); });

const listing = (seller: Actor, trade: Record<string, unknown> = {}) => {
  const id = randomUUID();
  listings.set(id, {
    id, sellerBusinessId: seller.businessId, title: "Kraft carton 5-ply", priceUnit: "piece", moqUnit: "piece", category: { id: "c", slug: "packaging", name: "Packaging" },
    trade: { sampleAvailable: true, samplePricePaise: 15_000, sampleMaxQty: 10, sampleDispatchDays: 3, ...trade },
  });
  return id;
};
const ask = async (buyer: Actor, over: Record<string, unknown> = {}) => {
  const v = await requestSample(buyer, { quantity: 2, shipTo: SHIP, ...over } as never);
  fx.track(v.id);
  return v;
};

describe("requesting a sample from a product page", () => {
  it("creates a request with the listing's sample price, a 48h deadline and an event", async () => {
    const d = await fx.deal();
    const lid = listing(d.seller);
    const v = await ask(d.buyer, { listingId: lid, note: "Need the 3-ply too" });
    expect(v).toMatchObject({ status: "requested", role: "buyer", subject: "Kraft carton 5-ply", quantity: 2, unit: "piece" });
    expect(v.payment).toMatchObject({ amountPaise: 15_000, free: false });
    expect(v.shipTo?.city).toBe("Bengaluru"); // the buyer sees their own address
    const hours = (new Date(v.respondBy).getTime() - new Date(v.createdAt).getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(48);
    expect(v.timeline.map((t) => t.status)).toEqual(["requested"]);
    const [ev] = await eventsFor("SampleRequested", v.id);
    expect(ev!.payload).toMatchObject({ buyerBusinessId: d.buyer.businessId, sellerBusinessId: d.seller.businessId, quantity: 2, amountPaise: 15_000 });
    expect(await countSellerPending(d.seller.businessId)).toBeGreaterThanOrEqual(1);
  });

  it("refuses when the seller does not offer samples, for your own product, over the quantity cap, and below the seller's tier", async () => {
    const d = await fx.deal();
    await expect(ask(d.buyer, { listingId: listing(d.seller, { sampleAvailable: false }) })).rejects.toMatchObject({ code: "conflict" });
    await expect(ask(d.seller, { listingId: listing(d.seller) })).rejects.toMatchObject({ key: "samples.ownProduct" });
    await expect(ask(d.buyer, { listingId: listing(d.seller), quantity: 11 })).rejects.toMatchObject({ key: "samples.quantityTooHigh" });
    await expect(ask(d.buyer, { listingId: listing(d.seller, { sampleMinBuyerTier: 2 }) })).rejects.toMatchObject({ code: "forbidden", key: "samples.tierRequired" });
    await expect(ask(d.buyer, { listingId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    await expect(ask(d.buyer, {})).rejects.toMatchObject({ code: "validation" }); // neither a listing nor a conversation
    await expect(ask(d.buyer, { listingId: listing(d.seller), shipTo: { ...SHIP, pincode: "12" } })).rejects.toMatchObject({ code: "validation" });
    const verified = await fx.deal({ buyerTier: 2 });
    await expect(ask(verified.buyer, { listingId: listing(d.seller, { sampleMinBuyerTier: 2 }) })).resolves.toMatchObject({ status: "requested" });
  });

  it("allows one open request per product", async () => {
    const d = await fx.deal();
    const lid = listing(d.seller);
    const first = await ask(d.buyer, { listingId: lid });
    await expect(ask(d.buyer, { listingId: lid })).rejects.toMatchObject({ key: "samples.duplicate" });
    await cancelSample(d.buyer, first.id);
    await expect(ask(d.buyer, { listingId: lid })).resolves.toMatchObject({ status: "requested" }); // a final status frees the slot
  });

  it("caps open requests per buyer business and requests per person per day", async () => {
    const d = await fx.deal();
    process.env.SAMPLES_MAX_OPEN_PER_BUYER = "2";
    try {
      await ask(d.buyer, { listingId: listing(d.seller) });
      await ask(d.buyer, { listingId: listing(d.seller) });
      await expect(ask(d.buyer, { listingId: listing(d.seller) })).rejects.toMatchObject({ key: "samples.tooManyOpen" });
    } finally { delete process.env.SAMPLES_MAX_OPEN_PER_BUYER; }
    const d2 = await fx.deal();
    process.env.SAMPLES_REQUESTS_PER_DAY = "1";
    try {
      await ask(d2.buyer, { listingId: listing(d2.seller) });
      await expect(ask(d2.buyer, { listingId: listing(d2.seller) })).rejects.toMatchObject({ code: "rate_limited" });
    } finally { delete process.env.SAMPLES_REQUESTS_PER_DAY; }
  });

  it("is off unless SAMPLES_ENABLED", async () => {
    const d = await fx.deal();
    process.env.SAMPLES_ENABLED = "false";
    try { await expect(ask(d.buyer, { listingId: listing(d.seller) })).rejects.toMatchObject({ key: "samples.notEnabled" }); } finally { process.env.SAMPLES_ENABLED = "true"; }
  });
});

describe("the full lifecycle inside a matched conversation", () => {
  it("requested -> accepted -> dispatched -> delivered -> approved, with masking, payment record and events", async () => {
    const d = await fx.deal();
    const v = await ask(d.buyer, { conversationId: d.conversationId, quoteId: d.quoteId, quantity: 3 });
    expect(v).toMatchObject({ enquiryId: d.enquiryId, matchId: d.matchId, quoteId: d.quoteId, subject: "Corrugated boxes", unit: "box" });
    expect(v.payment.free).toBe(true);

    // the seller sees the request but not the address until accepting
    const sellerSees = await getSample(d.seller, v.id);
    expect(sellerSees).toMatchObject({ role: "seller", shipTo: null, can: { respond: true, cancel: false, evaluate: false } });
    expect(await getSample({ personId: randomUUID(), businessId: randomUUID() }, v.id)).toBeNull(); // strangers get nothing

    // only the seller can answer; the buyer cannot
    await expect(acceptSample(d.buyer, v.id)).rejects.toMatchObject({ code: "forbidden" });
    const accepted = await acceptSample(d.seller, v.id, { amountPaise: 20_000, adjustableAgainstBulk: true, paymentNote: "UPI to the number on the invoice" });
    expect(accepted).toMatchObject({ status: "accepted", payment: { amountPaise: 20_000, adjustableAgainstBulk: true, free: false }, shipTo: { line1: "12 MG Road" } });
    expect(accepted.can).toMatchObject({ dispatch: true, recordPayment: true });
    await expect(acceptSample(d.seller, v.id)).rejects.toMatchObject({ code: "conflict" }); // answered once

    await expect(markSampleDelivered(d.buyer, v.id)).rejects.toMatchObject({ code: "conflict" }); // not dispatched yet
    await expect(dispatchSample(d.seller, v.id, { courier: "x" })).rejects.toMatchObject({ code: "validation" });
    const sent = await dispatchSample(d.seller, v.id, { courier: "Delhivery", trackingRef: "DL1234" });
    expect(sent).toMatchObject({ status: "dispatched", courier: "Delhivery", trackingRef: "DL1234" });
    await expect(cancelSample(d.buyer, v.id)).rejects.toMatchObject({ code: "conflict" }); // too late to cancel

    const paid = await recordSamplePayment(d.seller, v.id, "Received on UPI");
    expect(paid.payment.receivedAt).not.toBeNull();

    const got = await markSampleDelivered(d.buyer, v.id);
    expect(got).toMatchObject({ status: "delivered", deliveredBy: "buyer", can: { evaluate: true } });

    await expect(evaluateSample(d.seller, v.id, { approved: true })).rejects.toMatchObject({ code: "forbidden" });
    const done = await evaluateSample(d.buyer, v.id, { approved: true, notes: "Matches the spec" });
    expect(done).toMatchObject({ status: "approved", evaluation: { approved: true, notes: "Matches the spec" }, can: { requestBulk: true, acceptLinkedQuote: true } });
    expect(done.timeline.map((t) => t.status)).toEqual(["requested", "accepted", "dispatched", "delivered", "approved"]);

    for (const [type, payload] of [
      ["SampleAccepted", { amountPaise: 20_000, adjustableAgainstBulk: true }], ["SampleDispatched", { courier: "Delhivery", trackingRef: "DL1234" }],
      ["SampleDelivered", { deliveredBy: "buyer" }], ["SampleEvaluated", { approved: true, photoCount: 0 }],
    ] as const) {
      const [ev] = await eventsFor(type, v.id);
      expect(ev?.payload, type).toMatchObject({ buyerBusinessId: d.buyer.businessId, sellerBusinessId: d.seller.businessId, ...payload });
    }
    expect((await listBuyerSamples(d.buyer, { filter: "done" })).map((s) => s.id)).toContain(v.id);
    expect((await listSellerSamples(d.seller, { filter: "open" })).map((s) => s.id)).not.toContain(v.id);
  });

  it("a seller can mark delivered too; payment cannot be recorded for a free sample", async () => {
    const d = await fx.deal();
    const v = await ask(d.buyer, { conversationId: d.conversationId });
    await acceptSample(d.seller, v.id);
    await expect(recordSamplePayment(d.seller, v.id)).rejects.toMatchObject({ code: "conflict" });
    await dispatchSample(d.seller, v.id, { courier: "By hand" });
    expect(await markSampleDelivered(d.seller, v.id)).toMatchObject({ status: "delivered", deliveredBy: "seller" });
  });

  it("decline records a structured reason and frees the buyer's slot; the buyer can cancel before dispatch", async () => {
    const d = await fx.deal();
    const a = await ask(d.buyer, { conversationId: d.conversationId });
    expect(await declineSample(d.seller, a.id, { reason: "out_of_stock", note: "Back next week" })).toMatchObject({ status: "declined", declineReason: "out_of_stock", declineNote: "Back next week" });
    await expect(declineSample(d.seller, a.id, { reason: "other" })).rejects.toMatchObject({ code: "conflict" });
    await expect(declineSample(d.seller, (await ask(d.buyer, { conversationId: d.conversationId })).id, { reason: "nonsense" as never })).rejects.toMatchObject({ code: "validation" });
    const b = (await listBuyerSamples(d.buyer, { filter: "requested" }))[0]!;
    expect(await cancelSample(d.buyer, b.id)).toMatchObject({ status: "cancelled" });
    await expect(cancelSample(d.seller, b.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("seller SLA", () => {
  it("expires an unanswered request once, emits the event, and refuses a late answer", async () => {
    const d = await fx.deal();
    const v = await ask(d.buyer, { conversationId: d.conversationId });
    expect(await expireOverdueSamples(new Date(Date.now() + 47 * 3_600_000))).toBeGreaterThanOrEqual(0);
    expect((await getSample(d.buyer, v.id))!.status).toBe("requested"); // still inside the window
    await prisma.sampleRequest.update({ where: { id: v.id }, data: { respondBy: new Date(Date.now() - 1000) } });
    const late = await getSample(d.seller, v.id);
    expect(late).toMatchObject({ overdue: true, can: { respond: false } });
    await expect(acceptSample(d.seller, v.id)).rejects.toMatchObject({ key: "samples.expired" });
    expect(await expireOverdueSamples()).toBeGreaterThanOrEqual(1);
    expect(await expireOverdueSamples()).toBe(0); // idempotent
    expect(await getSample(d.buyer, v.id)).toMatchObject({ status: "expired" });
    expect(await eventsFor("SampleExpired", v.id)).toHaveLength(1);
    // the slot is free again
    await expect(ask(d.buyer, { conversationId: d.conversationId })).resolves.toMatchObject({ status: "requested" });
  });
});

describe("evaluation with photos", () => {
  async function delivered() {
    const d = await fx.deal();
    const v = await ask(d.buyer, { conversationId: d.conversationId });
    await acceptSample(d.seller, v.id);
    await dispatchSample(d.seller, v.id, { courier: "Blue Dart" });
    await markSampleDelivered(d.buyer, v.id);
    return { d, v };
  }

  it("a rejection needs a structured reason; photos are sniffed from bytes and stored privately", async () => {
    const { d, v } = await delivered();
    await expect(evaluateSample(d.buyer, v.id, { approved: false, reasons: [] })).rejects.toMatchObject({ key: "samples.reasonsRequired" });
    await expect(evaluateSample(d.buyer, v.id, { approved: false, reasons: ["bogus" as never] })).rejects.toMatchObject({ code: "validation" });
    await expect(evaluateSample(d.buyer, v.id, { approved: false, reasons: ["finish_defect"], photos: [{ bytes: new TextEncoder().encode("<script>"), mimeType: "image/jpeg" }] })).rejects.toMatchObject({ key: "samples.photoType" });
    await expect(evaluateSample(d.buyer, v.id, { approved: false, reasons: ["finish_defect"], photos: Array.from({ length: 6 }, () => ({ bytes: JPEG })) })).rejects.toMatchObject({ key: "samples.tooManyPhotos" });
    expect(store.files.size).toBe(0); // nothing stored for the failed attempts
    expect((await getSample(d.buyer, v.id))!.status).toBe("delivered");

    const r = await evaluateSample(d.buyer, v.id, { approved: false, reasons: ["finish_defect", "colour_mismatch", "finish_defect"], notes: "Edges are rough", photos: [{ bytes: JPEG }, { bytes: PNG }] });
    expect(r).toMatchObject({ status: "rejected", evaluation: { approved: false, reasons: ["finish_defect", "colour_mismatch"], notes: "Edges are rough" }, can: { requestBulk: false } });
    expect(r.evaluation!.photos).toHaveLength(2);
    expect([...store.files.keys()].every((k) => k.startsWith(`samples/${v.id}/`))).toBe(true);
    const [ev] = await eventsFor("SampleEvaluated", v.id);
    expect(ev!.payload).toMatchObject({ approved: false, reasons: ["finish_defect", "colour_mismatch"], photoCount: 2 });

    // both parties can open a photo; strangers cannot
    const pid = r.evaluation!.photos[0]!.id;
    expect((await readSamplePhoto(d.seller, v.id, pid))!.contentType).toBe("image/jpeg");
    expect(await readSamplePhoto(d.buyer, v.id, pid)).not.toBeNull();
    expect(await readSamplePhoto({ personId: randomUUID(), businessId: randomUUID() }, v.id, pid)).toBeNull();
    expect(await readSamplePhoto(d.buyer, v.id, randomUUID())).toBeNull();
  });
});

describe("approved sample to bulk order", () => {
  async function approved(opts: { withOrder?: boolean } = {}) {
    const d = await fx.deal({ order: opts.withOrder });
    const v = await ask(d.buyer, { conversationId: d.conversationId, quoteId: d.quoteId });
    await acceptSample(d.seller, v.id);
    await dispatchSample(d.seller, v.id, { courier: "DTDC" });
    await markSampleDelivered(d.buyer, v.id);
    await evaluateSample(d.buyer, v.id, { approved: true, photos: [{ bytes: JPEG }] });
    return { d, v };
  }

  it("pre-fills the RFQ and links the RFQ the buyer raises; only an approved sample qualifies", async () => {
    const { d, v } = await approved();
    const pre = await getBulkPrefill(d.buyer, v.id);
    expect(pre).toMatchObject({ sampleId: v.id, subject: "Corrugated boxes", sellerBusinessId: d.seller.businessId, quoteId: d.quoteId });
    expect(pre.requirementNote).toContain("Quality reference");
    await expect(getBulkPrefill(d.seller, v.id)).rejects.toMatchObject({ code: "forbidden" });

    const e2 = await prisma.enquiry.create({ data: { buyerBusinessId: d.buyer.businessId, buyerPersonId: d.buyer.personId, title: "Bulk boxes", requirement: "5000 boxes" } });
    fx.enquiryIds.push(e2.id);
    const stranger = await prisma.enquiry.create({ data: { buyerBusinessId: d.seller.businessId, buyerPersonId: d.seller.personId, title: "Not yours", requirement: "x" } });
    fx.enquiryIds.push(stranger.id);
    await expect(linkBulkEnquiry(d.buyer, v.id, stranger.id)).rejects.toMatchObject({ code: "not_found" }); // someone else's RFQ
    const linked = await linkBulkEnquiry(d.buyer, v.id, e2.id);
    expect(linked).toMatchObject({ bulkEnquiryId: e2.id, can: { requestBulk: false } });
    expect(await linkBulkEnquiry(d.buyer, v.id, e2.id)).toMatchObject({ bulkEnquiryId: e2.id }); // idempotent
    expect(await eventsFor("SampleBulkQuoteRequested", v.id)).toHaveLength(1);

    const pending = await fx.deal();
    const open = await ask(pending.buyer, { conversationId: pending.conversationId });
    await expect(getBulkPrefill(pending.buyer, open.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("shows the golden sample on the order page of both parties, matching on the quote or the RFQ", async () => {
    const { d, v } = await approved({ withOrder: true });
    const buyerSide = await getGoldenSampleForOrder(d.buyer, d.orderId!);
    expect(buyerSide).toMatchObject({ id: v.id, subject: "Corrugated boxes", role: "buyer", quantity: 2 });
    expect(buyerSide!.photos).toHaveLength(1);
    expect(await getGoldenSampleForOrder(d.seller, d.orderId!)).toMatchObject({ id: v.id, role: "seller" });
    expect(await getGoldenSampleForOrder({ personId: randomUUID(), businessId: randomUUID() }, d.orderId!)).toBeNull();
    expect(await getGoldenSampleForOrder(d.buyer, randomUUID())).toBeNull();

    // an unrelated order between the same parties does not inherit it
    const e3 = await prisma.enquiry.create({ data: { buyerBusinessId: d.buyer.businessId, buyerPersonId: d.buyer.personId, title: "Other", requirement: "other" } });
    fx.enquiryIds.push(e3.id);
    const o3 = await prisma.order.create({ data: { enquiryId: e3.id, buyerBusinessId: d.buyer.businessId, sellerBusinessId: d.seller.businessId, status: "recorded" } });
    fx.orderIds.push(o3.id);
    expect(await getGoldenSampleForOrder(d.buyer, o3.id)).toBeNull();
    await linkBulkEnquiry(d.buyer, v.id, e3.id);
    expect(await getGoldenSampleForOrder(d.buyer, o3.id)).toMatchObject({ id: v.id });
  });

  it("accepting the linked quote records the deal and the bulk request", async () => {
    const { d, v } = await approved();
    const r = await acceptLinkedQuote(d.buyer, v.id);
    expect(r.can.acceptLinkedQuote).toBe(false);
    expect(r.bulkEnquiryId).toBe(d.enquiryId);
    expect(await prisma.order.count({ where: { quoteId: d.quoteId } })).toBe(1);
    await prisma.order.deleteMany({ where: { quoteId: d.quoteId } });
    await expect(acceptLinkedQuote(d.buyer, v.id)).resolves.toMatchObject({ status: "approved" }); // idempotent
    const plain = await fx.deal();
    const nq = await ask(plain.buyer, { conversationId: plain.conversationId });
    await acceptSample(plain.seller, nq.id); await dispatchSample(plain.seller, nq.id, { courier: "x1" }); await markSampleDelivered(plain.buyer, nq.id);
    await evaluateSample(plain.buyer, nq.id, { approved: true });
    await expect(acceptLinkedQuote(plain.buyer, nq.id)).rejects.toMatchObject({ code: "conflict" }); // no linked quote
  });
});

describe("seller track record", () => {
  it("withholds the approval rate below 5 evaluated samples and shows it from 5", async () => {
    const d = await fx.deal();
    const run = async (approve: boolean) => {
      const v = await ask(d.buyer, { conversationId: d.conversationId });
      await acceptSample(d.seller, v.id); await dispatchSample(d.seller, v.id, { courier: "Speed Post" }); await markSampleDelivered(d.buyer, v.id);
      await evaluateSample(d.buyer, v.id, approve ? { approved: true } : { approved: false, reasons: ["quality_below_spec"] });
    };
    for (const ok of [true, true, false, true]) await run(ok);
    expect((await getSellerSampleStats([d.seller.businessId])).get(d.seller.businessId)).toMatchObject({ evaluated: 4, approved: 3, approvalRate: null });
    await run(true);
    expect((await getSellerSampleStats([d.seller.businessId])).get(d.seller.businessId)).toMatchObject({ evaluated: 5, approved: 4, approvalRate: 0.8, responded: 5 });
    expect((await getSellerSampleStats([])).size).toBe(0);
  });
});

describe("DPDP: export, retention and erasure", () => {
  it("exports the person's requests (with the ship-to) and the seller's side by business", async () => {
    const d = await fx.deal();
    const v = await ask(d.buyer, { conversationId: d.conversationId, note: "Call before delivery" });
    const mine = (await exportPersonalData(d.buyer.personId, { businessIds: [d.buyer.businessId] })) as { sampleRequests: { items: { id: string; shipLine1: string; amountPaise: number }[] } };
    expect(mine.sampleRequests.items.find((r) => r.id === v.id)).toMatchObject({ shipLine1: "12 MG Road", amountPaise: 0 });
    const theirs = (await exportPersonalData(d.seller.personId, { businessIds: [d.seller.businessId] })) as { sampleRequests: { items: { id: string }[] } };
    expect(theirs.sampleRequests.items.map((r) => r.id)).toContain(v.id);
    expect(JSON.stringify(mine)).not.toContain("samples/"); // no private keys
  });

  it("retention purges personal content of FINAL requests only, deletes photos and keeps the structured facts", async () => {
    const d = await fx.deal();
    const open = await ask(d.buyer, { conversationId: d.conversationId });
    await acceptSample(d.seller, open.id); await dispatchSample(d.seller, open.id, { courier: "Gati" }); await markSampleDelivered(d.buyer, open.id);
    const done = await evaluateSample(d.buyer, open.id, { approved: false, reasons: ["dimensions_off"], notes: "3mm short", photos: [{ bytes: JPEG }] });
    const live = await ask(d.buyer, { conversationId: d.conversationId });
    const future = new Date(Date.now() + 86_400_000);
    expect(await purgeClosedSamplePersonalData(future, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await purgeClosedSamplePersonalData(new Date(Date.now() - 86_400_000))).toBe(0); // not old enough
    expect(await purgeClosedSamplePersonalData(future)).toBeGreaterThanOrEqual(1);
    const after = (await getSample(d.buyer, open.id))!;
    expect(after).toMatchObject({ status: "rejected", shipTo: null, buyerNote: null, evaluation: { reasons: ["dimensions_off"], notes: null, photos: [] } });
    expect(store.files.has(`samples/${open.id}/${done.evaluation!.photos[0]!.id}.jpg`)).toBe(false);
    expect((await getSample(d.buyer, live.id))!.shipTo).not.toBeNull(); // the open one is untouched
    expect(await purgeClosedSamplePersonalData(future)).toBe(0); // idempotent
  });

  it("erasure removes the person's data from every request, open or not", async () => {
    const d = await fx.deal();
    const v = await ask(d.buyer, { conversationId: d.conversationId, note: "private" });
    expect(await erasePersonSamples(d.buyer.personId)).toBe(1);
    expect(await getSample(d.buyer, v.id)).toMatchObject({ status: "requested", shipTo: null, buyerNote: null });
    expect(await erasePersonSamples(d.buyer.personId)).toBe(0);
  });
});
