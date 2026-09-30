import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, name: `Biz ${i.slice(0, 4)}` }])),
}));

import { worker } from "../src/worker";
import { getOrderParties, availableActions, confirmOrder, getOrder, listOrders, markOrderEscrowed, recordExternalOrder, rolesFor, transitionOrder, type ExternalOrderInput } from "../src";

const tag = `ext-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const orderIds: string[] = [];

async function party(name: string) {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}` } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}
const input = (seller: string, over: Partial<ExternalOrderInput> = {}): ExternalOrderInput => ({
  externalRef: `ondc:${randomUUID()}`, source: "ondc", ondcOrderId: "O-1", sellerBusinessId: seller, buyerLabel: "Acme Traders (buyer-app.example)",
  bapId: "buyer-app.example", transactionId: randomUUID(), items: [{ listingId: randomUUID(), quantity: 10, unitPricePaise: 5000, unit: "kg" }], totalPaise: 50_000, currency: "INR",
  ...over,
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${orderIds})`;
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("recordExternalOrder (ONDC, ADR-017)", () => {
  it("books a network order idempotently with the buyer label, buyer-side pre-confirmed, no lead", async () => {
    const seller = await party("seller");
    const network = await party("network");
    const i = input(seller.businessId);
    const a = await recordExternalOrder(i, network.businessId);
    const b = await recordExternalOrder(i, network.businessId);
    orderIds.push(a.orderId);
    expect(a.created).toBe(true);
    expect(b).toEqual({ orderId: a.orderId, created: false });
    const v = (await getOrder(seller, a.orderId))!;
    expect(v).toMatchObject({ matchId: null, enquiryId: null, externalRef: i.externalRef, enquiryTitle: "ONDC order", settlement: "ondc", status: "recorded", role: "seller", pricePaise: 5000, quantity: 10, unit: "kg", totalPaise: 50_000 });
    expect(v.counterparty.name).toBe("Acme Traders (buyer-app.example)");
    expect(v.buyerConfirmedAt).not.toBeNull();
    expect((await listOrders(seller, { role: "seller" })).items.map((o) => o.id)).toContain(a.orderId);
    expect(await prisma.domainEvent.count({ where: { type: "OrderRecorded", aggregateId: a.orderId } })).toBe(0);
  });

  it("multi-line orders keep only the total; seller confirms, then reports fulfilment through to completed", async () => {
    const seller = await party("seller2");
    const network = await party("network2");
    const { orderId } = await recordExternalOrder(input(seller.businessId, {
      items: [{ listingId: randomUUID(), quantity: 2, unitPricePaise: 100, unit: null }, { listingId: randomUUID(), quantity: 1, unitPricePaise: 300, unit: "box" }], totalPaise: 500, buyerLabel: null,
    }), network.businessId);
    orderIds.push(orderId);
    expect(await getOrder(seller, orderId)).toMatchObject({ pricePaise: null, quantity: null, unit: null, totalPaise: 500 });
    expect((await confirmOrder(seller, orderId)).status).toBe("confirmed");
    expect((await transitionOrder(seller, orderId, "dispatched")).actions.moves).toEqual(["delivered"]);
    await transitionOrder(seller, orderId, "delivered");
    expect((await transitionOrder(seller, orderId, "completed")).status).toBe("completed");
    const moves = await prisma.domainEvent.findMany({ where: { type: "OrderStatusChanged", aggregateId: orderId }, orderBy: { id: "asc" } });
    expect(moves.map((e) => (e.payload as { to: string }).to)).toEqual(["confirmed", "dispatched", "delivered", "completed"]);
  });

  it("validates reference, businesses, currency, amounts and items", async () => {
    const s = (await party("seller3")).businessId;
    const n = (await party("network3")).businessId;
    await expect(recordExternalOrder(input(s, { externalRef: "no spaces allowed" }), n)).rejects.toThrow(/external reference/);
    await expect(recordExternalOrder(input("nope"), n)).rejects.toThrow(/Invalid business/);
    await expect(recordExternalOrder(input(s), "nope")).rejects.toThrow(/Invalid business/);
    await expect(recordExternalOrder(input(s, { currency: "USD" as "INR" }), n)).rejects.toThrow(/INR/);
    await expect(recordExternalOrder(input(s, { totalPaise: -1 }), n)).rejects.toThrow(/whole paise/);
    await expect(recordExternalOrder(input(s, { items: [] }), n)).rejects.toThrow(/at least one item/);
    await expect(recordExternalOrder(input(s, { items: [{ listingId: "x", quantity: 0, unitPricePaise: 1, unit: null }] }), n)).rejects.toThrow(/Quantity/);
  });
});

describe("settlement-aware moves", () => {
  it("only network orders let the seller report delivery and completion", () => {
    expect(rolesFor({}, "delivered")).toEqual(["buyer"]);
    expect(rolesFor({ settlement: "escrow" }, "completed")).toEqual(["buyer"]);
    expect(rolesFor({ settlement: "ondc" }, "delivered")).toEqual(["buyer", "seller"]);
    expect(rolesFor({ settlement: "ondc" }, "dispatched")).toEqual(["seller"]);
    const s = { status: "dispatched" as const, buyerConfirmedAt: new Date(), sellerConfirmedAt: new Date() };
    expect(availableActions(s, "seller").moves).toEqual([]);
    expect(availableActions({ ...s, settlement: "ondc" }, "seller").moves).toEqual(["delivered"]);
  });
});

describe("markOrderEscrowed (EscrowFunded)", () => {
  it("flips off_platform to escrow once; never touches network orders or unknown ids", async () => {
    const buyer = await party("b4");
    const seller = await party("s4");
    const o = await prisma.order.create({ data: { buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, externalRef: `test:${randomUUID()}` } });
    orderIds.push(o.id);
    expect(await markOrderEscrowed(o.id)).toBe(true);
    expect(await markOrderEscrowed(o.id)).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).settlement).toBe("escrow");
    const { orderId } = await recordExternalOrder(input(seller.businessId), buyer.businessId);
    orderIds.push(orderId);
    expect(await markOrderEscrowed(orderId)).toBe(false);
    expect(await markOrderEscrowed("nope")).toBe(false);
    const o2 = await prisma.order.create({ data: { buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, externalRef: `test:${randomUUID()}` } });
    orderIds.push(o2.id);
    await worker.handlers!.EscrowFunded!({ id: 1, type: "EscrowFunded", version: 1, aggregateType: "escrow", aggregateId: "e", occurredAt: new Date().toISOString(), payload: { escrowId: "e", orderId: o2.id, amountPaise: 1, partnerRef: "p", matchId: null } });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o2.id } })).settlement).toBe("escrow");
  });
});

describe("getOrderParties (system read for notifiers)", () => {
  it("returns both businesses; null for unknown or malformed ids", async () => {
    const seller = await party("s5");
    const network = await party("n5");
    const { orderId } = await recordExternalOrder(input(seller.businessId), network.businessId);
    orderIds.push(orderId);
    expect(await getOrderParties(orderId)).toEqual({ buyerBusinessId: network.businessId, sellerBusinessId: seller.businessId, matchId: null });
    expect(await getOrderParties(randomUUID())).toBeNull();
    expect(await getOrderParties("nope")).toBeNull();
  });
});
