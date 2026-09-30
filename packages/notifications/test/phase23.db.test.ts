import { MemoryJobQueue, redis, setJobQueue, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ renders: [] as any[] }));
vi.mock("@cnote/templates", () => ({
  defineTemplates: () => {},
  isChannelEnabled: async () => true,
  renderText: async (key: string, ch: string, vars: Record<string, unknown>) => { h.renders.push({ key, ch, vars }); return { title: `T ${key}`, body: `B ${JSON.stringify(vars)}` }; },
}));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { setPreference } from "../src/preferences";
import { notifyForEvent } from "../src/pipeline";
import type { Directory } from "../src/recipients";

const BUYER = randomUUID(), SELLER = randomUUID(), BB = randomUUID(), SB = randomUUID();
const people = [BUYER, SELLER];
let nid = Date.now() * 10 + 5;
const ev = (type: string, payload: unknown): DomainEvent => ({ id: nid++, type, version: 1, aggregateType: "x", aggregateId: "x", payload, occurredAt: new Date().toISOString() }) as never;
const dir: Directory = {
  businessMembers: async (b) => (b === BB ? [BUYER] : [SELLER]), businessName: async () => "X", enquiry: async () => null, conversation: async () => null,
  listingTitle: async () => null, review: async () => null, comment: async () => null, contact: async () => null,
  orderParties: async () => ({ buyerBusinessId: BB, sellerBusinessId: SB }),
};
let queue: MemoryJobQueue;
const rows = (personId: string) => prisma.notification.findMany({ where: { personId }, orderBy: { createdAt: "asc" } });

beforeEach(async () => {
  h.renders = [];
  queue = new MemoryJobQueue();
  setJobQueue(queue);
  await prisma.notification.deleteMany({ where: { personId: { in: people } } });
  await prisma.notificationPreference.deleteMany({ where: { personId: { in: people } } });
  for (const p of people) await redis.del(...(["web", "seller", "admin"].map((a) => `notif:unread:${p}:${a}`)));
});
afterAll(async () => {
  await prisma.notification.deleteMany({ where: { personId: { in: people } } });
  await prisma.notificationPreference.deleteMany({ where: { personId: { in: people } } });
});

const frozen = () => ev("EscrowFrozen", { escrowId: "e", orderId: "o1", disputeId: "d1" });

describe("phase 2/3 pipeline", () => {
  it("dispute freeze notifies both parties in their own apps, idempotently on redelivery", async () => {
    const e = frozen();
    await notifyForEvent(e, dir);
    await notifyForEvent(e, dir); // at-least-once redelivery
    const [b, s] = [await rows(BUYER), await rows(SELLER)];
    expect(b).toHaveLength(1);
    expect(s).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: "escrow.frozen", app: "web", href: "/buyer/disputes/d1", businessId: BB });
    expect(s[0]).toMatchObject({ kind: "escrow.frozen", app: "seller", href: "/disputes/d1", businessId: SB });
  });

  it("payout settled goes to the seller with rupee-formatted variables", async () => {
    await notifyForEvent(ev("PayoutSettled", { payoutId: "p", escrowId: "e", sellerBusinessId: SB, amountPaise: 2475000, partnerRef: "r", latencyMs: 1 }), dir);
    const [n] = await rows(SELLER);
    expect(n).toMatchObject({ kind: "escrow.payout_settled", app: "seller" });
    expect(h.renders[0].vars).toMatchObject({ amount: "₹24,750", href: "/orders" });
  });

  it("respects preferences: in-app can be turned off per category", async () => {
    await setPreference(SELLER, "billing", "in_app", false);
    await notifyForEvent(ev("CreditOverdue", { loanId: "l", businessId: SB, dpd: 2 }), dir);
    expect(await rows(SELLER)).toHaveLength(0);
  });

  it("resolver not wired: no notification and no error", async () => {
    await notifyForEvent(frozen(), { ...dir, orderParties: async () => null });
    expect(await rows(BUYER)).toHaveLength(0);
    expect(await rows(SELLER)).toHaveLength(0);
  });

  it("order tracking goes to the buyer app only", async () => {
    await notifyForEvent(ev("OrderFulfilmentUpdated", { orderId: "o1", buyerBusinessId: BB, sellerBusinessId: SB, stage: "packed", note: null }), dir);
    expect(await rows(SELLER)).toHaveLength(0);
    expect((await rows(BUYER))[0]).toMatchObject({ kind: "order.fulfilment_updated", app: "web", href: "/buyer/orders/o1" });
  });
});
