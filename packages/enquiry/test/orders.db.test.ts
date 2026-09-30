import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, name: `Biz ${i.slice(0, 4)}` }])),
}));

import { confirmOrder, getOrder, listOrders, recordOrderFromDeal, reportDeal, transitionOrder } from "../src";

type Actor = { personId: string; businessId: string };
const tag = `ord-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
let uid = 0;

async function party(name: string): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}

async function deal(opts: { status?: "accepted" | "offered"; quote?: { pricePaise: number; quantity: number; unit: string } } = {}) {
  const buyer = await party("buyer");
  const seller = await party("seller");
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Boxes", requirement: "Need boxes" } });
  enquiryIds.push(e.id);
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: opts.status ?? "accepted", respondBy: new Date() } });
  matchIds.push(m.id);
  const c = await prisma.conversation.create({ data: { matchId: m.id } });
  let quoteId: string | undefined;
  if (opts.quote) {
    const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: seller.businessId, pricePaise: BigInt(opts.quote.pricePaise), quantity: opts.quote.quantity, unit: opts.quote.unit } });
    quoteId = q.id;
  }
  return { buyer, seller, matchId: m.id, conversationId: c.id, quoteId };
}

afterAll(async () => {
  await prisma.order.deleteMany({ where: { matchId: { in: matchIds } } });
  const convos = (await prisma.conversation.findMany({ where: { matchId: { in: matchIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.dealReport.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${matchIds}) OR payload->>'matchId' = ANY(${matchIds}) OR payload->>'buyerBusinessId' = ANY(${bizIds})`;
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

const events = (type: string, bizId: string) =>
  prisma.$queryRaw<{ payload: Record<string, unknown> }[]>`SELECT payload FROM domain_events WHERE type = ${type} AND payload->>'buyerBusinessId' = ${bizId} ORDER BY id`;

describe("recordOrderFromDeal", () => {
  it("computes totals in paise from the quote, emits OrderRecorded once, and is idempotent per match", async () => {
    const d = await deal({ quote: { pricePaise: 250_000, quantity: 40, unit: "pcs" } });
    const a = await recordOrderFromDeal(d.buyer, d.matchId, { quoteId: d.quoteId });
    expect(a).toMatchObject({ status: "recorded", pricePaise: 250_000, quantity: 40, unit: "pcs", totalPaise: 10_000_000, role: "buyer", quoteId: d.quoteId });
    const b = await recordOrderFromDeal(d.seller, d.matchId, { quantity: 1 });
    expect(b.id).toBe(a.id);
    expect(b.totalPaise).toBe(10_000_000);
    expect(b.role).toBe("seller");
    expect(await prisma.order.count({ where: { matchId: d.matchId } })).toBe(1);
    const ev = await events("OrderRecorded", d.buyer.businessId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ orderId: a.id, matchId: d.matchId, totalPaise: 10_000_000 });
  });

  it("explicit input overrides the quote; totals stay bigint-safe; null when unknown", async () => {
    const d = await deal({ quote: { pricePaise: 100, quantity: 2, unit: "pcs" } });
    const o = await recordOrderFromDeal(d.seller, d.matchId, { pricePaise: 300, quantity: 5, unit: "kg" });
    expect(o).toMatchObject({ pricePaise: 300, quantity: 5, unit: "kg", totalPaise: 1500 });
    const bare = await deal();
    expect(await recordOrderFromDeal(bare.buyer, bare.matchId)).toMatchObject({ pricePaise: null, quantity: null, totalPaise: null });
  });

  it("validates input, the quote's ownership, the match state and participants", async () => {
    const d = await deal({ quote: { pricePaise: 100, quantity: 2, unit: "pcs" } });
    const other = await deal({ quote: { pricePaise: 100, quantity: 2, unit: "pcs" } });
    await expect(recordOrderFromDeal(d.buyer, d.matchId, { quantity: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(recordOrderFromDeal(d.buyer, d.matchId, { pricePaise: -1 })).rejects.toMatchObject({ code: "validation" });
    await expect(recordOrderFromDeal(d.buyer, d.matchId, { unit: " " })).rejects.toMatchObject({ code: "validation" });
    await expect(recordOrderFromDeal(d.buyer, d.matchId, { quoteId: other.quoteId })).rejects.toMatchObject({ code: "not_found" });
    await expect(recordOrderFromDeal(d.buyer, d.matchId, { quoteId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(recordOrderFromDeal(other.buyer, d.matchId)).rejects.toMatchObject({ code: "not_found" });
    await expect(recordOrderFromDeal(d.buyer, "bad")).rejects.toMatchObject({ code: "not_found" });
    await expect(recordOrderFromDeal(d.buyer, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    const offered = await deal({ status: "offered" });
    await expect(recordOrderFromDeal(offered.buyer, offered.matchId)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("reportDeal hook", () => {
  it("records an order on the first 'won' (using the reported value), never on lost/pending, and only once", async () => {
    const d = await deal({ quote: { pricePaise: 100, quantity: 2, unit: "pcs" } });
    await reportDeal(d.buyer, d.matchId, "pending");
    await reportDeal(d.buyer, d.matchId, "lost");
    expect(await prisma.order.count({ where: { matchId: d.matchId } })).toBe(0);
    await reportDeal(d.buyer, d.matchId, "won", 777_00);
    await reportDeal(d.seller, d.matchId, "won", 999_00);
    const o = await prisma.order.findMany({ where: { matchId: d.matchId } });
    expect(o).toHaveLength(1);
    expect(o[0]!.totalPaise).toBe(77_700n);
    expect(o[0]!.quoteId).toBe(d.quoteId);
    expect(await events("OrderRecorded", d.buyer.businessId)).toHaveLength(1);
  });
});

describe("confirmation and transitions", () => {
  it("full happy path with roles, events and idempotent confirmation", async () => {
    const d = await deal();
    const o = await recordOrderFromDeal(d.buyer, d.matchId, { pricePaise: 10, quantity: 3 });
    const c1 = await confirmOrder(d.buyer, o.id);
    expect(c1.status).toBe("recorded");
    expect(c1.buyerConfirmedAt).not.toBeNull();
    expect((await confirmOrder(d.buyer, o.id)).buyerConfirmedAt).toBe(c1.buyerConfirmedAt);
    await expect(transitionOrder(d.seller, o.id, "dispatched")).rejects.toMatchObject({ code: "conflict" });
    const c2 = await confirmOrder(d.seller, o.id);
    expect(c2.status).toBe("confirmed");
    await expect(transitionOrder(d.buyer, o.id, "dispatched")).rejects.toMatchObject({ code: "forbidden" });
    expect((await transitionOrder(d.seller, o.id, "dispatched")).status).toBe("dispatched");
    await expect(transitionOrder(d.seller, o.id, "delivered")).rejects.toMatchObject({ code: "forbidden" });
    await expect(transitionOrder(d.buyer, o.id, "cancelled")).rejects.toMatchObject({ code: "conflict" });
    expect((await transitionOrder(d.buyer, o.id, "delivered")).status).toBe("delivered");
    expect((await transitionOrder(d.buyer, o.id, "completed")).status).toBe("completed");
    await expect(confirmOrder(d.seller, o.id)).resolves.toMatchObject({ status: "completed" });
    const changes = (await events("OrderStatusChanged", d.buyer.businessId)).map((e) => `${e.payload.from}>${e.payload.to}`);
    expect(changes).toEqual(["recorded>confirmed", "confirmed>dispatched", "dispatched>delivered", "delivered>completed"]);
  });

  it("either party can cancel before dispatch; cancelled is final", async () => {
    const d = await deal();
    const o = await recordOrderFromDeal(d.buyer, d.matchId);
    expect((await transitionOrder(d.seller, o.id, "cancelled")).status).toBe("cancelled");
    await expect(confirmOrder(d.buyer, o.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(transitionOrder(d.buyer, o.id, "cancelled")).rejects.toMatchObject({ code: "conflict" });
  });

  it("non-participants get not_found and cannot read", async () => {
    const d = await deal();
    const stranger = await party("stranger");
    const o = await recordOrderFromDeal(d.buyer, d.matchId);
    await expect(confirmOrder(stranger, o.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(transitionOrder(stranger, o.id, "cancelled")).rejects.toMatchObject({ code: "not_found" });
    await expect(transitionOrder(d.buyer, "bad", "cancelled")).rejects.toMatchObject({ code: "not_found" });
    expect(await getOrder(stranger, o.id)).toBeNull();
    expect(await getOrder(d.buyer, "bad")).toBeNull();
    expect((await getOrder(d.seller, o.id))?.counterparty.businessId).toBe(d.buyer.businessId);
    expect((await listOrders(stranger, { role: "buyer" })).items).toEqual([]);
  });
});

describe("listOrders", () => {
  it("lists by role, newest first, paginated with a cursor", async () => {
    const buyer = await party("multi-buyer");
    const seller = await party("multi-seller");
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: `E${i}`, requirement: "r" } });
      enquiryIds.push(e.id);
      const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 1, status: "accepted", respondBy: new Date() } });
      matchIds.push(m.id);
      ids.push((await recordOrderFromDeal(buyer, m.id, { quantity: 1 })).id);
    }
    const p1 = await listOrders(buyer, { role: "buyer" });
    expect(p1.items).toHaveLength(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listOrders(buyer, { role: "buyer", cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((o) => o.id))).toEqual(new Set(ids));
    expect((await listOrders(buyer, { role: "seller" })).items).toEqual([]);
    expect((await listOrders(seller, { role: "seller", cursor: "garbage" })).items).toHaveLength(20);
  });
});
