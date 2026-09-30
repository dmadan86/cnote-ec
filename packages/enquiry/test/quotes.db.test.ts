import { prisma } from "@cnote/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/catalogue", () => ({
  listCategories: async () => [],
  getCategoryBySlug: async () => null,
  getListing: async () => null,
  getPublicListing: async () => null,
  findSellerCandidates: async () => [],
}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async () => new Map(), hasConsent: async () => true }));
vi.mock("@cnote/ai", () => ({}));

import { getConversation, getQuote, listSellerQuotes, quoteTermsSchema, sendQuote } from "../src";

const tag = `quote-test-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
let buyer: { personId: string; businessId: string };
let seller: { personId: string; businessId: string };
let other: { personId: string; businessId: string };
let conversationIds: string[] = [];
let enquiryIds: string[] = [];

async function party(name: string) {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}` } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}

async function convo(title: string, status: "accepted" | "offered" = "accepted") {
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title, requirement: "Need things urgently" } });
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status, respondBy: new Date(Date.now() + 3600_000) } });
  const c = await prisma.conversation.create({ data: { matchId: m.id } });
  enquiryIds.push(e.id); conversationIds.push(c.id);
  return { enquiryId: e.id, matchId: m.id, conversationId: c.id };
}

beforeAll(async () => {
  buyer = await party("buyer"); seller = await party("seller"); other = await party("other");
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${conversationIds})`;
  await prisma.quote.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("structured quote terms", () => {
  it("stays backward compatible: no terms means null terms", async () => {
    const c = await convo("Plain quote");
    const { quoteId } = await sendQuote(seller, c.conversationId, { pricePaise: 1000, quantity: 10, unit: "pcs" });
    const q = await getQuote(seller, quoteId);
    expect(q).toMatchObject({ moq: null, deliveryTerms: null, deliveryChargePaise: null, paymentTerms: null, gstIncluded: null, role: "seller" });
  });

  it("persists terms and exposes them via getConversation and getQuote", async () => {
    const c = await convo("Full terms");
    const { quoteId } = await sendQuote(seller, c.conversationId, {
      pricePaise: 1250, quantity: 500, unit: "pcs", moq: 200, moqUnit: "pcs", deliveryTerms: "fob", deliveryNote: "Pune godown",
      deliveryChargePaise: 250000, paymentTerms: "net_30", paymentNote: "against GRN", gstIncluded: false,
    });
    const conv = await getConversation(buyer, c.conversationId);
    expect(conv!.quotes[0]).toMatchObject({
      id: quoteId, moq: 200, moqUnit: "pcs", deliveryTerms: "fob", deliveryNote: "Pune godown", deliveryChargePaise: 250000,
      paymentTerms: "net_30", paymentNote: "against GRN", gstIncluded: false,
    });
    expect(await getQuote(buyer, quoteId)).toMatchObject({ role: "buyer", enquiryId: c.enquiryId, matchId: c.matchId, conversationId: c.conversationId });
  });

  it("does not change the QuoteSent payload shape", async () => {
    const c = await convo("Event shape");
    const { quoteId } = await sendQuote(seller, c.conversationId, { pricePaise: 900, quantity: 5, unit: "kg", moq: 1, paymentTerms: "advance" });
    const rows = await prisma.$queryRaw<{ payload: Record<string, unknown> }[]>`SELECT payload FROM domain_events WHERE type = 'QuoteSent' AND payload->>'quoteId' = ${quoteId}`;
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(["conversationId", "pricePaise", "quantity", "quoteId", "sellerBusinessId"]);
  });

  it("rejects invalid terms", async () => {
    const c = await convo("Bad terms");
    const base = { pricePaise: 1, quantity: 1, unit: "pcs" };
    await expect(sendQuote(seller, c.conversationId, { ...base, deliveryTerms: "drone" as never })).rejects.toThrow();
    await expect(sendQuote(seller, c.conversationId, { ...base, paymentTerms: "barter" as never })).rejects.toThrow();
    await expect(sendQuote(seller, c.conversationId, { ...base, moq: 0 })).rejects.toThrow();
    await expect(sendQuote(seller, c.conversationId, { ...base, deliveryChargePaise: -5 })).rejects.toThrow();
  });

  it("schema normalises blanks to null", () => {
    expect(quoteTermsSchema.parse({ deliveryNote: "  ", moqUnit: "" })).toMatchObject({ deliveryNote: null, moqUnit: null, gstIncluded: null });
  });
});

describe("getQuote access", () => {
  it("is participants-only and tolerates bad ids", async () => {
    const c = await convo("Access");
    const { quoteId } = await sendQuote(seller, c.conversationId, { pricePaise: 100, quantity: 1, unit: "pcs" });
    expect(await getQuote(other, quoteId)).toBeNull();
    expect(await getQuote(buyer, "not-a-uuid")).toBeNull();
    expect(await getQuote(buyer, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("listSellerQuotes", () => {
  it("returns only the seller's own quotes, keyset-paged, newest first", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await convo(`Paged ${i}`);
      ids.push((await sendQuote(seller, c.conversationId, { pricePaise: 100 + i, quantity: 1, unit: "pcs" })).quoteId);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listSellerQuotes>> = await listSellerQuotes(seller, { cursor, limit: 2 });
      seen.push(...page.items.map((i) => i.id));
      expect(page.items.length).toBeLessThanOrEqual(2);
      cursor = page.nextCursor; pages++;
    } while (cursor && pages < 20);
    const mine = seen.filter((id) => ids.includes(id));
    expect(mine).toHaveLength(5);
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine).toEqual([...ids].reverse());
    const first = (await listSellerQuotes(seller, { limit: 1 })).items[0]!;
    expect(first).toMatchObject({ enquiryTitle: "Paged 4", category: null });
    expect((await listSellerQuotes(other)).items).toEqual([]);
  });

  it("rejects a malformed cursor and clamps limit", async () => {
    await expect(listSellerQuotes(seller, { cursor: "garbage" })).rejects.toMatchObject({ code: "validation" });
    expect((await listSellerQuotes(seller, { limit: 0 })).items.length).toBeLessThanOrEqual(1);
  });
});
