import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cnote/db";
import { cancelOffer, createOffer, decideHonourReport, getOfferForListing, listHonourReports, listOffersForReview, listSellerOffers, processOffers, reportOfferNotHonoured, reviewOffer, revalidateListingOffers, suspendOffer } from "../src/index";
import { cleanup, DAY, mkBusiness, mkListing, setListing, uid } from "./helpers";

afterAll(cleanup);
const inDays = (n: number) => new Date(Date.now() + n * DAY);

describe("createOffer", () => {
  it("auto-approves a clean timed offer with a platform-derived reference (full 30d history)", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 45 });
    const o = await createOffer(s.id, { kind: "timed_price", listingId: l.id, terms: { unitPricePaise: 8_000 }, endsAt: inDays(5) });
    expect(o).toMatchObject({ status: "active", referencePricePaise: 10_000, discountBps: 2000, reviewFlags: [] });
    const pub = await getOfferForListing(l.id);
    expect(pub?.timed).toMatchObject({ unitPricePaise: 8_000, reference: { pricePaise: 10_000, percentOff: 20 } });
    const events = await prisma.domainEvent.findMany({ where: { aggregateId: o.id }, orderBy: { id: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["OfferCreated", "OfferActivated"]);
  });

  it("short history: price only, never a strike-through or percentage", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 5 });
    const o = await createOffer(s.id, { kind: "timed_price", listingId: l.id, terms: { unitPricePaise: 8_000 }, endsAt: inDays(5) });
    expect(o).toMatchObject({ status: "active", referencePricePaise: null, discountBps: null });
    expect((await getOfferForListing(l.id))?.timed).toMatchObject({ unitPricePaise: 8_000, reference: null });
  });

  it("a seller cannot inflate the strike-through by raising the price first", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 60, historyPaise: 8_000, pricePaise: 8_000 });
    // price raised yesterday to 20000 (history row + live price)
    await prisma.listingPriceHistory.create({ data: { listingId: l.id, pricePaise: 20_000n, priceUnit: "piece", effectiveFrom: inDays(-1) } });
    setListing(l.id, { pricePaise: 20_000 });
    // 15000 is 25% "off" the raised price but above the 8000 30-day low: not a real discount
    await expect(createOffer(s.id, { kind: "timed_price", listingId: l.id, terms: { unitPricePaise: 15_000 }, endsAt: inDays(3) })).rejects.toMatchObject({ code: "validation" });
    const ok = await createOffer(s.id, { kind: "timed_price", listingId: l.id, terms: { unitPricePaise: 6_000 }, endsAt: inDays(3) });
    expect(ok.referencePricePaise).toBe(8_000);
    expect(ok.discountBps).toBe(2500);
    const pub = await getOfferForListing(l.id);
    expect(pub!.timed!.reference!.pricePaise).toBeLessThanOrEqual(8_000);
  });

  it("holds deep discounts for review, then staff approve/reject", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const o = await createOffer(s.id, { kind: "timed_price", listingId: l.id, terms: { unitPricePaise: 3_000 }, endsAt: inDays(4) });
    expect(o).toMatchObject({ status: "needs_review", reviewFlags: ["deep_discount"] });
    expect(await getOfferForListing(l.id)).toBeNull();
    expect((await listOffersForReview()).some((x) => x.id === o.id)).toBe(true);
    await expect(reviewOffer(o.id, "reject", uid())).rejects.toMatchObject({ code: "validation" }); // reason required
    const approved = await reviewOffer(o.id, "approve", uid(), "checked with seller");
    expect(approved.status).toBe("active");
    const l2 = await mkListing(s.id, { historyDays: 40 });
    const o2 = await createOffer(s.id, { kind: "timed_price", listingId: l2.id, terms: { unitPricePaise: 3_000 }, endsAt: inDays(4) });
    expect((await reviewOffer(o2.id, "reject", uid(), "price looks like a typo")).status).toBe("rejected");
    await expect(reviewOffer(o2.id, "approve", uid())).rejects.toMatchObject({ code: "conflict" });
  });

  it("eligibility: own listing, live listing, tier >= 1", async () => {
    const s = await mkBusiness(1);
    const other = await mkBusiness(1);
    const t0 = await mkBusiness(0);
    const l = await mkListing(s.id, { historyDays: 40 });
    const input = { kind: "timed_price" as const, listingId: l.id, terms: { unitPricePaise: 8_000 }, endsAt: inDays(3) };
    await expect(createOffer(other.id, input)).rejects.toMatchObject({ code: "forbidden" });
    const l0 = await mkListing(t0.id, { historyDays: 40 });
    await expect(createOffer(t0.id, { ...input, listingId: l0.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createOffer(s.id, { ...input, listingId: uid() })).rejects.toMatchObject({ code: "not_found" });
    setListing(l.id, { published: false });
    await expect(createOffer(s.id, input)).rejects.toMatchObject({ code: "not_found" });
  });

  it("one open offer per kind; 14-day cooldown after a timed offer; schedule window", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const input = (n: number, len = 3) => ({ kind: "timed_price" as const, listingId: l.id, terms: { unitPricePaise: 8_000 }, startsAt: inDays(n), endsAt: inDays(n + len) });
    const a = await createOffer(s.id, input(0));
    await expect(createOffer(s.id, input(0))).rejects.toMatchObject({ code: "conflict" });
    await cancelOffer(a.id, s.id);
    // ended just now (cancelled): next timed offer must wait 14 days
    await expect(createOffer(s.id, input(5))).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/14-day gap/) });
    const later = await createOffer(s.id, input(15));
    expect(later.status).toBe("draft"); // scheduled, activated by the job
    await expect(createOffer(s.id, { ...input(0), startsAt: inDays(-2) })).rejects.toMatchObject({ code: "validation" });
    await expect(createOffer(s.id, { ...input(0), startsAt: inDays(40), endsAt: inDays(43) })).rejects.toMatchObject({ code: "validation" });
  });

  it("volume tiers and free delivery activate, are public, and can be cancelled by the owner only", async () => {
    const s = await mkBusiness(1);
    const other = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const v = await createOffer(s.id, { kind: "volume_tiers", listingId: l.id, terms: { tiers: [{ minQty: 10, unitPricePaise: 9_000 }, { minQty: 100, unitPricePaise: 7_000 }] } });
    const f = await createOffer(s.id, { kind: "free_delivery_moq", listingId: l.id, terms: { minQty: 500, regions: ["Karnataka"] } });
    const pub = await getOfferForListing(l.id);
    expect(pub?.tiers?.tiers).toEqual([{ minQty: 10, unitPricePaise: 9_000, percentOff: 10 }, { minQty: 100, unitPricePaise: 7_000, percentOff: 30 }]);
    expect(pub?.freeDelivery).toMatchObject({ minQty: 500, regions: ["Karnataka"] });
    await expect(cancelOffer(v.id, other.id)).rejects.toMatchObject({ code: "forbidden" });
    await cancelOffer(v.id, s.id);
    await cancelOffer(f.id, s.id);
    expect(await getOfferForListing(l.id)).toBeNull(); // hard purge on cancel
    await expect(cancelOffer(v.id, s.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await listSellerOffers(s.id)).length).toBe(2);
  });
});

describe("lifecycle jobs and cache", () => {
  it("expiry job ends an offer and the public read never serves it past endsAt", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const o = await createOffer(s.id, { kind: "volume_tiers", listingId: l.id, terms: { tiers: [{ minQty: 10, unitPricePaise: 9_000 }] }, endsAt: new Date(Date.now() + 1500) });
    expect(await getOfferForListing(l.id)).not.toBeNull(); // now cached
    await new Promise((r) => setTimeout(r, 1700)); // endsAt passes; no job has run and the cache entry is still warm
    expect(await getOfferForListing(l.id)).toBeNull(); // expiry re-checked on read
    const r = await processOffers();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await prisma.listingOffer.findUnique({ where: { id: o.id } }))!).toMatchObject({ status: "expired", endedReason: "expired" });
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: o.id } })).map((e) => e.type)).toContain("OfferEnded");
  });

  it("scheduled offer is activated by the job with the reference computed at activation", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const o = await createOffer(s.id, { kind: "timed_price", listingId: l.id, terms: { unitPricePaise: 8_000 }, startsAt: inDays(2), endsAt: inDays(5) });
    expect(o.status).toBe("draft");
    expect(o.referencePricePaise).toBeNull();
    await processOffers(); // not due
    expect((await prisma.listingOffer.findUnique({ where: { id: o.id } }))!.status).toBe("draft");
    await prisma.listingOffer.update({ where: { id: o.id }, data: { startsAt: new Date(Date.now() - 1000) } });
    expect((await processOffers()).activated).toBeGreaterThanOrEqual(1);
    expect(await prisma.listingOffer.findUnique({ where: { id: o.id } })).toMatchObject({ status: "active", referencePricePaise: 10_000n, discountBps: 2000 });
  });

  it("listing price change re-validates: invalid offers end with listing_changed", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const o = await createOffer(s.id, { kind: "timed_price", listingId: l.id, terms: { unitPricePaise: 8_000 }, endsAt: inDays(5) });
    setListing(l.id, { pricePaise: 7_900 }); // seller dropped the base below the offer price
    expect(await revalidateListingOffers(l.id)).toBe(1);
    expect(await prisma.listingOffer.findUnique({ where: { id: o.id } })).toMatchObject({ status: "suspended", endedReason: "listing_changed" });
    expect(await getOfferForListing(l.id)).toBeNull();
  });

  it("staff can suspend; PROMOTIONS_ENABLED=false hides offers and blocks creation", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const o = await createOffer(s.id, { kind: "volume_tiers", listingId: l.id, terms: { tiers: [{ minQty: 10, unitPricePaise: 9_000 }] } });
    process.env.PROMOTIONS_ENABLED = "false";
    try {
      expect(await getOfferForListing(l.id)).toBeNull();
      await expect(createOffer(s.id, { kind: "free_delivery_moq", listingId: l.id, terms: { minQty: 100 } })).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      delete process.env.PROMOTIONS_ENABLED;
    }
    expect(await getOfferForListing(l.id)).not.toBeNull();
    await expect(suspendOffer(o.id, uid(), " ")).rejects.toMatchObject({ code: "validation" });
    expect((await suspendOffer(o.id, uid(), "complaint")).status).toBe("suspended");
  });
});

describe("honour reports", () => {
  it("report -> decide upheld emits OfferHonourDecided; repeat offenders lose offer privileges", async () => {
    const s = await mkBusiness(1);
    const buyer = await mkBusiness(0, { seller: false });
    const l = await mkListing(s.id, { historyDays: 40 });
    const o = await createOffer(s.id, { kind: "volume_tiers", listingId: l.id, terms: { tiers: [{ minQty: 10, unitPricePaise: 9_000 }] } });
    await expect(reportOfferNotHonoured({ offerId: o.id, reporterBusinessId: s.id })).rejects.toMatchObject({ code: "forbidden" });
    const r = await reportOfferNotHonoured({ offerId: o.id, reporterBusinessId: buyer.id, note: "Seller quoted the old price" });
    expect((await reportOfferNotHonoured({ offerId: o.id, reporterBusinessId: buyer.id })).id).toBe(r.id); // dedup while open
    expect((await listHonourReports()).some((x) => x.id === r.id)).toBe(true);
    const d = await decideHonourReport(r.id, { upheld: true, decidedBy: uid() });
    expect(d).toMatchObject({ upheld: true, sellerSuspended: false });
    await expect(decideHonourReport(r.id, { upheld: false, decidedBy: uid() })).rejects.toMatchObject({ code: "conflict" });
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: o.id } })).map((e) => e.type)).toEqual(expect.arrayContaining(["OfferHonourReported", "OfferHonourDecided"]));
    // a dismissed report is not held against the seller
    const dismissed = await reportOfferNotHonoured({ offerId: o.id, reporterBusinessId: (await mkBusiness(0, { seller: false })).id });
    expect((await decideHonourReport(dismissed.id, { upheld: false, decidedBy: uid() })).upheld).toBe(false);

    // two more upheld reports (3 total in 90 days) suspend privileges and pull open offers
    for (let i = 0; i < 2; i++) {
      const rep = await reportOfferNotHonoured({ offerId: o.id, reporterBusinessId: (await mkBusiness(0, { seller: false })).id });
      const res = await decideHonourReport(rep.id, { upheld: true, decidedBy: uid() });
      expect(res.sellerSuspended).toBe(i === 1);
    }
    expect((await prisma.listingOffer.findUnique({ where: { id: o.id } }))!.status).toBe("suspended");
    const l2 = await mkListing(s.id, { historyDays: 40 });
    await expect(createOffer(s.id, { kind: "volume_tiers", listingId: l2.id, terms: { tiers: [{ minQty: 10, unitPricePaise: 9_000 }] } })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a seller with a prior upheld report gets their next offer flagged for review", async () => {
    const s = await mkBusiness(1);
    const l = await mkListing(s.id, { historyDays: 40 });
    const o = await createOffer(s.id, { kind: "volume_tiers", listingId: l.id, terms: { tiers: [{ minQty: 10, unitPricePaise: 9_000 }] } });
    const rep = await reportOfferNotHonoured({ offerId: o.id, reporterBusinessId: (await mkBusiness(0, { seller: false })).id });
    await decideHonourReport(rep.id, { upheld: true, decidedBy: uid() });
    const l2 = await mkListing(s.id, { historyDays: 40 });
    const o2 = await createOffer(s.id, { kind: "volume_tiers", listingId: l2.id, terms: { tiers: [{ minQty: 10, unitPricePaise: 9_000 }] } });
    expect(o2).toMatchObject({ status: "needs_review", reviewFlags: ["prior_honour_complaint"] });
  });

  it("rejects reports for unknown or never-live offers", async () => {
    const buyer = await mkBusiness(0, { seller: false });
    await expect(reportOfferNotHonoured({ offerId: uid(), reporterBusinessId: buyer.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(reportOfferNotHonoured({ offerId: "nope", reporterBusinessId: buyer.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(decideHonourReport(uid(), { upheld: true, decidedBy: uid() })).rejects.toMatchObject({ code: "not_found" });
  });
});
