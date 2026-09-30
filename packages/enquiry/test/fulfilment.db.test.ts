import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, name: `Biz ${i.slice(0, 4)}` }])),
}));

import { getOrder, listFulfilmentEvents, recordFulfilmentStage, transitionOrder } from "../src";

type Actor = { personId: string; businessId: string };
const tag = `ful-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const orderIds: string[] = [];
let uid = 0;

async function party(name: string): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}
async function order(status: "recorded" | "confirmed" | "dispatched" | "delivered" | "cancelled" = "confirmed", settlement = "off_platform") {
  const buyer = await party("buyer");
  const seller = await party("seller");
  const o = await prisma.order.create({ data: { buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, status, settlement, buyerConfirmedAt: new Date(), sellerConfirmedAt: new Date() } });
  orderIds.push(o.id);
  return { buyer, seller, id: o.id };
}
const events = (id: string) => prisma.$queryRaw<{ payload: Record<string, unknown> }[]>`SELECT payload FROM domain_events WHERE type = 'OrderFulfilmentUpdated' AND aggregate_id::text = ${id} ORDER BY id`;

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${orderIds})`;
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } }); // history rows cascade
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("recordFulfilmentStage", () => {
  it("records packed -> in_transit -> out_for_delivery with tracking, history and events, leaving the status alone", async () => {
    const o = await order("confirmed");
    expect((await getOrder(o.seller, o.id))!.actions.fulfilment).toEqual(["packed"]);
    expect(await recordFulfilmentStage(o.seller, o.id, { stage: "packed", note: "  Boxed   and sealed " })).toEqual({ changed: true });
    // packed is a before-dispatch stage; the rest need dispatch
    await expect(recordFulfilmentStage(o.seller, o.id, { stage: "in_transit" })).rejects.toMatchObject({ code: "conflict" });
    await transitionOrder(o.seller, o.id, "dispatched");
    await recordFulfilmentStage(o.seller, o.id, { stage: "in_transit", courier: "Delhivery", trackingRef: "AWB123" });
    await recordFulfilmentStage(o.seller, o.id, { stage: "out_for_delivery", note: "With the rider" });

    const v = (await getOrder(o.buyer, o.id))!;
    expect(v).toMatchObject({ status: "dispatched", fulfilmentStage: "out_for_delivery", trackingCourier: "Delhivery", trackingRef: "AWB123" });
    expect(v.actions.fulfilment).toEqual([]); // buyer records nothing
    expect((await getOrder(o.seller, o.id))!.actions.fulfilment).toEqual(["delivery_attempted"]);

    const h = await listFulfilmentEvents(o.buyer, o.id);
    expect(h.map((x) => x.stage)).toEqual(["packed", "in_transit", "out_for_delivery"]);
    expect(h[0]).toMatchObject({ note: "Boxed and sealed", courier: null, trackingRef: null });
    expect(h[2]).toMatchObject({ courier: "Delhivery", trackingRef: "AWB123" }); // tracking carries forward
    const ev = await events(o.id);
    expect(ev.map((e) => e.payload.stage)).toEqual(["packed", "in_transit", "out_for_delivery"]);
    expect(ev[1]!.payload).toMatchObject({ orderId: o.id, buyerBusinessId: o.buyer.businessId, sellerBusinessId: o.seller.businessId, note: null });
  });

  it("is idempotent for the current stage, and refuses to go backwards", async () => {
    const o = await order("dispatched");
    await recordFulfilmentStage(o.seller, o.id, { stage: "out_for_delivery" });
    expect(await recordFulfilmentStage(o.seller, o.id, { stage: "out_for_delivery", note: "again" })).toEqual({ changed: false });
    await expect(recordFulfilmentStage(o.seller, o.id, { stage: "in_transit" })).rejects.toMatchObject({ code: "conflict" });
    expect(await listFulfilmentEvents(o.seller, o.id)).toHaveLength(1);
    expect(await events(o.id)).toHaveLength(1);
  });

  it("serialises concurrent identical requests into one history row and one event", async () => {
    const o = await order("dispatched");
    const r = await Promise.all([1, 2, 3].map(() => recordFulfilmentStage(o.seller, o.id, { stage: "in_transit" })));
    expect(r.filter((x) => x.changed)).toHaveLength(1);
    expect(await listFulfilmentEvents(o.seller, o.id)).toHaveLength(1);
    expect(await events(o.id)).toHaveLength(1);
  });

  it("only the seller may record; strangers see nothing; terminal orders are closed", async () => {
    const o = await order("dispatched");
    const stranger = await party("stranger");
    await expect(recordFulfilmentStage(o.buyer, o.id, { stage: "in_transit" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(recordFulfilmentStage(stranger, o.id, { stage: "in_transit" })).rejects.toMatchObject({ code: "not_found" });
    await expect(recordFulfilmentStage(o.seller, "bad", { stage: "in_transit" })).rejects.toMatchObject({ code: "not_found" });
    await expect(recordFulfilmentStage(o.seller, randomUUID(), { stage: "in_transit" })).rejects.toMatchObject({ code: "not_found" });
    expect(await listFulfilmentEvents(stranger, o.id)).toEqual([]);
    expect(await listFulfilmentEvents(o.seller, "bad")).toEqual([]);
    for (const status of ["recorded", "delivered", "cancelled"] as const) {
      const t = await order(status);
      await expect(recordFulfilmentStage(t.seller, t.id, { stage: status === "recorded" ? "packed" : "out_for_delivery" })).rejects.toMatchObject({ code: "conflict" });
    }
  });

  it("validates note and tracking fields", async () => {
    const o = await order("dispatched");
    await expect(recordFulfilmentStage(o.seller, o.id, { stage: "in_transit", note: "x".repeat(501) })).rejects.toMatchObject({ code: "validation" });
    await expect(recordFulfilmentStage(o.seller, o.id, { stage: "in_transit", courier: "y".repeat(81) })).rejects.toMatchObject({ code: "validation" });
    await expect(recordFulfilmentStage(o.seller, o.id, { stage: "in_transit", trackingRef: "bad\u0000ref" })).rejects.toMatchObject({ code: "validation" });
    await recordFulfilmentStage(o.seller, o.id, { stage: "in_transit", note: "   ", courier: " ", trackingRef: null });
    expect((await listFulfilmentEvents(o.seller, o.id))[0]).toMatchObject({ note: null, courier: null });
  });

  it("works for network (ONDC) orders and keeps the main status machine and escrow-relevant status unchanged", async () => {
    const o = await order("confirmed", "ondc");
    await recordFulfilmentStage(o.seller, o.id, { stage: "packed" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("confirmed");
    expect(await prisma.domainEvent.count({ where: { type: "OrderStatusChanged", aggregateId: o.id } })).toBe(0);
  });
});
