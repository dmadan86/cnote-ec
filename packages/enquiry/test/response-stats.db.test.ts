import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { getSupplierResponseStats, MIN_RESPONSE_SAMPLE, toResponseStats } from "../src";

describe("toResponseStats (pure)", () => {
  it("suppresses every number below the sample threshold", () => {
    const s = toResponseStats({ resolved: MIN_RESPONSE_SAMPLE - 1, accepted: 4, responded: 4, medianSeconds: 600 });
    expect(s).toMatchObject({ sufficient: false, medianFirstResponseMinutes: null, acceptRate: null, sample: 4 });
  });
  it("reports median minutes and accept rate at the threshold", () => {
    const s = toResponseStats({ resolved: 5, accepted: 4, responded: 5, medianSeconds: 1800 });
    expect(s).toMatchObject({ sufficient: true, medianFirstResponseMinutes: 30, acceptRate: 0.8 });
  });
  it("has no median when the supplier never replied, but still shows the 0% accept rate", () => {
    const s = toResponseStats({ resolved: 6, accepted: 0, responded: 0, medianSeconds: null });
    expect(s).toMatchObject({ sufficient: true, medianFirstResponseMinutes: null, acceptRate: 0 });
  });
  it("treats a missing row as a new supplier", () => {
    expect(toResponseStats(undefined)).toMatchObject({ sufficient: false, sample: 0 });
  });
});

const tag = `rs-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];

afterAll(async () => {
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

async function offer(sellerId: string, buyer: { personId: string; businessId: string }, o: { status: "accepted" | "declined" | "expired" | "offered"; replyMinutes?: number; ageDays?: number }) {
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "x", requirement: "x" } });
  enquiryIds.push(e.id);
  const offeredAt = new Date(Date.now() - (o.ageDays ?? 1) * 86400_000);
  await prisma.match.create({
    data: {
      enquiryId: e.id, sellerBusinessId: sellerId, rank: 1, matchScore: 0.9, status: o.status, offeredAt,
      respondBy: new Date(offeredAt.getTime() + 2 * 3600_000),
      respondedAt: o.replyMinutes != null ? new Date(offeredAt.getTime() + o.replyMinutes * 60_000) : null,
    },
  });
}

describe("getSupplierResponseStats", () => {
  it("computes median first response and accept rate over the 90-day window, ignoring older and pending offers", async () => {
    const p = await prisma.person.create({ data: { name: `${tag}-buyer` } });
    const buyerBiz = await prisma.business.create({ data: { name: `${tag}-buyer` } });
    const seller = await prisma.business.create({ data: { name: `${tag}-seller`, isSeller: true } });
    const thin = await prisma.business.create({ data: { name: `${tag}-thin`, isSeller: true } });
    personIds.push(p.id);
    bizIds.push(buyerBiz.id, seller.id, thin.id);
    const buyer = { personId: p.id, businessId: buyerBiz.id };

    // 5 resolved in window: replies of 10, 20, 30 min (accepted, accepted, declined), 2 expired
    await offer(seller.id, buyer, { status: "accepted", replyMinutes: 10 });
    await offer(seller.id, buyer, { status: "accepted", replyMinutes: 20 });
    await offer(seller.id, buyer, { status: "declined", replyMinutes: 30 });
    await offer(seller.id, buyer, { status: "expired" });
    await offer(seller.id, buyer, { status: "expired" });
    // noise that must not count: older than 90 days, and still pending inside its response window
    await offer(seller.id, buyer, { status: "accepted", replyMinutes: 5, ageDays: 120 });
    const pending = await prisma.enquiry.create({ data: { buyerBusinessId: buyerBiz.id, buyerPersonId: p.id, title: "x", requirement: "x" } });
    enquiryIds.push(pending.id);
    await prisma.match.create({ data: { enquiryId: pending.id, sellerBusinessId: seller.id, rank: 1, matchScore: 0.9, status: "offered", respondBy: new Date(Date.now() + 3600_000) } });

    for (let i = 0; i < 3; i++) await offer(thin.id, buyer, { status: "accepted", replyMinutes: 1 });

    const stats = await getSupplierResponseStats([seller.id, thin.id]);
    expect(stats.get(seller.id)).toMatchObject({ sample: 5, sufficient: true, medianFirstResponseMinutes: 20, acceptRate: 0.4 });
    // 3 resolved offers: below the threshold, so no numbers at all
    expect(stats.get(thin.id)).toMatchObject({ sample: 3, sufficient: false, medianFirstResponseMinutes: null, acceptRate: null });
  });
});
