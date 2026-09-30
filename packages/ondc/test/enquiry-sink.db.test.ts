import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { enquiryOrderSink, wireOndcOrderSink } from "../src/enquiry-sink";
import { getOrderSink, mirrorDecision, setOrderSink, type ExternalOrderInput } from "../src/sink";

const biz: string[] = [];
const orders: string[] = [];
afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${orders})`;
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.business.deleteMany({ where: { id: { in: biz } } });
  setOrderSink(null);
});
async function seller() {
  const b = await prisma.business.create({ data: { name: `ondc-sink-${randomUUID().slice(0, 6)}`, isSeller: true } });
  biz.push(b.id);
  return b.id;
}
const input = (sellerBusinessId: string): ExternalOrderInput => ({
  externalRef: `ondc:${randomUUID()}`, source: "ondc", ondcOrderId: randomUUID(), sellerBusinessId, buyerLabel: "Net Buyer", bapId: "bap.example",
  transactionId: randomUUID(), items: [{ listingId: randomUUID(), quantity: 3, unitPricePaise: 1000, unit: "pcs" }], totalPaise: 3000, currency: "INR",
});

describe("enquiryOrderSink", () => {
  it("mirrors an ONDC order into a platform order (idempotent) and confirms it when the seller accepts", async () => {
    const s = await seller();
    const i = input(s);
    const a = (await enquiryOrderSink.recordExternalOrder(i))!;
    const b = (await enquiryOrderSink.recordExternalOrder(i))!;
    orders.push(a.orderId);
    expect(b.orderId).toBe(a.orderId);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } });
    expect(row).toMatchObject({ settlement: "ondc", externalRef: i.externalRef, externalBuyerLabel: "Net Buyer", sellerBusinessId: s, matchId: null });
    await enquiryOrderSink.onAccepted!(a.orderId, s);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } })).status).toBe("confirmed");
  });
  it("cancels the platform order when the seller rejects", async () => {
    const s = await seller();
    const { orderId } = (await enquiryOrderSink.recordExternalOrder(input(s)))!;
    orders.push(orderId);
    await enquiryOrderSink.onRejected!(orderId, s);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("cancelled");
  });
  it("wireOndcOrderSink installs it; mirrorDecision is best effort", async () => {
    wireOndcOrderSink();
    wireOndcOrderSink();
    expect(getOrderSink()).toBe(enquiryOrderSink);
    const onAccepted = vi.fn(async () => { throw new Error("boom"); });
    const onRejected = vi.fn(async () => undefined);
    setOrderSink({ recordExternalOrder: async () => null, onAccepted, onRejected });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(mirrorDecision("accepted", "o1", "s1")).resolves.toBeUndefined();
    await mirrorDecision("rejected", "o2", "s2");
    await mirrorDecision("accepted", null, "s3");
    expect(onAccepted).toHaveBeenCalledWith("o1", "s1");
    expect(onRejected).toHaveBeenCalledWith("o2", "s2");
    expect(onAccepted).toHaveBeenCalledTimes(1);
    err.mockRestore();
    setOrderSink(null);
    await mirrorDecision("accepted", "o1", "s1");
  });
});
