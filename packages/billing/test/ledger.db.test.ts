import { prisma } from "@cnote/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeCredit, expireLapsedCredits, getBalance, grantCredits, listPlans, refundCredit, seedPlans, subscribe, cancelSubscriptionWithQuote, getActiveSubscription } from "../src";

let bizId: string;
const uniq = `billing-test-${Date.now()}`;

beforeAll(async () => {
  bizId = (await prisma.business.create({ data: { name: uniq } })).id;
});
afterAll(async () => {
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: bizId } });
  await prisma.subscription.deleteMany({ where: { businessId: bizId } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: bizId } });
  await prisma.business.delete({ where: { id: bizId } });
});

const consume = (ref: string) => prisma.$transaction((tx) => consumeCredit(tx, bizId, { refType: "match", refId: ref }));

describe("ledger (DB)", () => {
  it("seeds plans lazily", async () => {
    const plans = await listPlans();
    expect(plans.map((p) => p.code)).toEqual(expect.arrayContaining(["free", "starter", "pro"]));
  });

  it("concurrent first-time seeding never fails and never exposes a partial catalogue", async () => {
    await Promise.all(Array.from({ length: 6 }, () => seedPlans()));
    expect((await prisma.plan.findMany({ where: { code: { in: ["free", "starter", "pro"] } } })).length).toBe(3);
  });

  it("concurrent consume on a 1-credit balance: exactly one succeeds", async () => {
    await grantCredits(bizId, 1, "test", { refType: "test", refId: "g1" });
    const results = await Promise.allSettled([consume("m1"), consume("m2"), consume("m3"), consume("m4")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.every((f) => f.reason.code === "insufficient_credits")).toBe(true);
    expect(await getBalance(bizId)).toBe(0);
  });

  it("refunds once", async () => {
    await grantCredits(bizId, 1, "test", { refType: "test", refId: "g2" });
    const id = await consume("mR");
    expect(await consume("mR")).toBe(id); // idempotent retry
    expect(await getBalance(bizId)).toBe(0);
    const r1 = await prisma.$transaction((tx) => refundCredit(tx, id));
    const r2 = await prisma.$transaction((tx) => refundCredit(tx, id));
    expect(r1).toBeTruthy();
    expect(r2).toBeNull();
    expect(await getBalance(bizId)).toBe(1);
  });

  it("expire job writes entries for lapsed grants once", async () => {
    await prisma.creditLedgerEntry.create({
      data: { businessId: bizId, delta: 7, reason: "grant", refType: "test", refId: "old", expiresAt: new Date(Date.now() - 86_400_000) },
    });
    expect(await expireLapsedCredits()).toBeGreaterThanOrEqual(1);
    const before = await prisma.creditLedgerEntry.count({ where: { businessId: bizId, reason: "expire" } });
    await expireLapsedCredits();
    expect(await prisma.creditLedgerEntry.count({ where: { businessId: bizId, reason: "expire" } })).toBe(before);
  });

  it("subscribe grants credits with autoRenew false; cancel keeps credits and schedules the end", async () => {
    const start = await getBalance(bizId);
    const sub = await subscribe(bizId, "starter");
    expect(sub.autoRenew).toBe(false);
    expect(await getBalance(bizId)).toBe(start + 60);
    const q = await cancelSubscriptionWithQuote(bizId);
    expect(q.refundPaise).toBe(0);
    expect(await getActiveSubscription(bizId)).toMatchObject({ planCode: "starter", cancelAtPeriodEnd: true }); // stays until the period ends
    expect(await getBalance(bizId)).toBe(start + 60);
  });
});
