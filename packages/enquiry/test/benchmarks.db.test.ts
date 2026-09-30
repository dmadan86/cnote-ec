import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { listPriceFacts } from "../src";

const tag = `bm-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
let categoryId = "";

async function party(name: string) {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}` } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}
async function enquiry(buyer: { personId: string; businessId: string }, withCategory: boolean) {
  return prisma.enquiry.create({
    data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "x", requirement: "x", categoryId: withCategory ? categoryId : null, deliveryPincode: "400001", deliveryCity: "Mumbai" },
  });
}

afterAll(async () => {
  await prisma.order.deleteMany({ where: { matchId: { in: matchIds } } });
  const convos = (await prisma.conversation.findMany({ where: { matchId: { in: matchIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  if (categoryId) await prisma.category.delete({ where: { id: categoryId } });
});

async function seed() {
  categoryId = (await prisma.category.create({ data: { slug: `${tag}-cat`, name: tag } })).id;
  const buyer = await party("buyer");
  const seller = await party("seller");
  const out: { quoteIds: string[]; orderId: string; quoteForOrder: string } = { quoteIds: [], orderId: "", quoteForOrder: "" };
  for (let i = 0; i < 3; i++) {
    const e = await enquiry(buyer, i < 2);
    enquiryIds.push(e.id);
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
    matchIds.push(m.id);
    const c = await prisma.conversation.create({ data: { matchId: m.id } });
    const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: seller.businessId, pricePaise: BigInt(1000 + i), quantity: 10, unit: "kg" } });
    if (i < 2) out.quoteIds.push(q.id);
    if (i === 0) {
      out.quoteForOrder = q.id;
      const o = await prisma.order.create({ data: { matchId: m.id, enquiryId: e.id, quoteId: q.id, buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, settlement: "escrow", status: "confirmed", pricePaise: 1000n, quantity: 10, unit: "kg", totalPaise: 10000n } });
      out.orderId = o.id;
    }
  }
  // off-platform order on a categorised enquiry: never a price fact
  const e = await enquiry(buyer, true);
  enquiryIds.push(e.id);
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
  matchIds.push(m.id);
  await prisma.order.create({ data: { matchId: m.id, enquiryId: e.id, buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, status: "confirmed", pricePaise: 5n, quantity: 1, unit: "kg" } });
  return out;
}

describe("listPriceFacts", () => {
  it("returns categorised quotes and escrow orders only, with delivery area and counterparty ids for counting", async () => {
    const s = await seed();
    const since = new Date(Date.now() - 3600_000);
    const mine = <T extends { categoryId: string }>(items: T[]) => items.filter((i) => i.categoryId === categoryId);
    const quotes = mine((await listPriceFacts({ source: "quote", since })).items);
    expect(quotes.map((q) => q.id).sort()).toEqual([...s.quoteIds].sort());
    expect(quotes[0]).toMatchObject({ source: "quote", escrow: false, unit: "kg", deliveryPincode: "400001", deliveryCity: "Mumbai" });
    expect(quotes[0]!.sellerBusinessId).toBeTruthy();
    const orders = mine((await listPriceFacts({ source: "order", since })).items);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: s.orderId, source: "order", escrow: true, quoteId: s.quoteForOrder, pricePaise: 1000, quantity: 10 });
  });

  it("pages by keyset without gaps or repeats and honours the time window", async () => {
    const since = new Date(Date.now() - 3600_000);
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const page: Awaited<ReturnType<typeof listPriceFacts>> = await listPriceFacts({ source: "quote", since, after, limit: 1 });
      seen.push(...page.items.map((x) => x.id));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const all = (await listPriceFacts({ source: "quote", since, limit: 1000 })).items.map((x) => x.id);
    expect(seen.sort()).toEqual(all.sort());
    const future = await listPriceFacts({ source: "quote", since: new Date(Date.now() + 3600_000) });
    expect(future.items).toHaveLength(0);
    const past = await listPriceFacts({ source: "order", since: new Date(0), until: new Date(1) });
    expect(past.items).toHaveLength(0);
    expect(randomUUID()).toBeTruthy();
  });
});
