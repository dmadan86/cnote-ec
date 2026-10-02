import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSubscription, cancelSubscriptionWithQuote, consumeCredit, endLapsedSubscriptions, expireLapsedCredits, getActiveSubscription,
  getBalance, getCreditLots, getLedger, grantCredits, listPlans, refundCredit, seedPlans, subscribe,
} from "../src";
import { getPlan } from "../src/plans";
import { grantCreditsTx } from "../src/ledger";
import { startFreePlan } from "../src/subscriptions";
import { worker } from "../src/worker";
import { toPlanView } from "../src/plans";

const created: string[] = [];
async function biz(): Promise<string> {
  const b = await prisma.business.create({ data: { name: `billing-x-${Date.now()}-${Math.random()}` } });
  created.push(b.id);
  return b.id;
}
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: created } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: created } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: created } } });
  await prisma.business.deleteMany({ where: { id: { in: created } } });
});
const consume = (b: string, ref: string) => prisma.$transaction((tx) => consumeCredit(tx, b, { refType: "match", refId: ref }));
const events = (b: string, type: string) => prisma.domainEvent.count({ where: { aggregateId: b, type } });

let b: string;
beforeEach(async () => { b = await biz(); });

describe("consume concurrency", () => {
  it.each([1, 3, 5])("N=8 parallel consumes on balance %i: exactly that many succeed, balance ends 0", async (k) => {
    await grantCredits(b, k, "t", { refType: "t", refId: "g" });
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => consume(b, `m${i}`)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(k);
    for (const r of res) if (r.status === "rejected") expect(r.reason.code).toBe("insufficient_credits");
    expect(await getBalance(b)).toBe(0);
    expect(await prisma.creditLedgerEntry.count({ where: { businessId: b, reason: "consume" } })).toBe(k);
  });

  it("parallel consumes of the SAME ref consume once (idempotent)", async () => {
    await grantCredits(b, 5, "t", { refType: "t", refId: "g" });
    const ids = await Promise.all(Array.from({ length: 6 }, () => consume(b, "same")));
    expect(new Set(ids).size).toBe(1);
    expect(await getBalance(b)).toBe(4);
    expect(await events(b, "CreditConsumed")).toBe(1);
  });

  it("insufficient balance leaves the ledger untouched and rolls back the tx", async () => {
    await expect(consume(b, "x")).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(await prisma.creditLedgerEntry.count({ where: { businessId: b } })).toBe(0);
    expect(await events(b, "CreditConsumed")).toBe(0);
  });

  it("re-consume after refund is allowed and spends again", async () => {
    await grantCredits(b, 2, "t", { refType: "t", refId: "g" });
    const first = await consume(b, "r");
    await prisma.$transaction((tx) => refundCredit(tx, first));
    expect(await getBalance(b)).toBe(2);
    const second = await consume(b, "r");
    expect(second).not.toBe(first);
    expect(await getBalance(b)).toBe(1);
  });
});

describe("grant / refund", () => {
  it("grant is idempotent per ref, validates amount, sets 90d expiry, emits once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const [a, c] = await Promise.all([grantCredits(b, 4, "why", { refType: "sub", refId: "1" }), grantCredits(b, 4, "why", { refType: "sub", refId: "1" })]);
    expect(a).toBe(c);
    expect(await getBalance(b)).toBe(4);
    expect(await events(b, "CreditsGranted")).toBe(1);
    const lots = await getCreditLots(b);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.expiresAt).toBe("2026-05-30T00:00:00.000Z");
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(grantCredits(b, bad, "x", { refType: "t", refId: "bad" })).rejects.toMatchObject({ code: "validation" });
    }
    await expect(prisma.$transaction((tx) => grantCreditsTx(tx, b, 0, "x", { refType: "t", refId: "z" }))).rejects.toBeTruthy();
  });

  it("refund: unknown / non-consume txn -> not_found; concurrent refunds credit exactly once", async () => {
    await expect(prisma.$transaction((tx) => refundCredit(tx, "00000000-0000-0000-0000-000000000000"))).rejects.toMatchObject({ code: "not_found" });
    const g = await grantCredits(b, 1, "t", { refType: "t", refId: "g" });
    await expect(prisma.$transaction((tx) => refundCredit(tx, g))).rejects.toMatchObject({ code: "not_found" });
    const c = await consume(b, "m");
    const res = await Promise.all(Array.from({ length: 5 }, () => prisma.$transaction((tx) => refundCredit(tx, c))));
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(await getBalance(b)).toBe(1);
    expect(await events(b, "CreditRefunded")).toBe(1);
  });

  it("refunded credit gets a fresh 90 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    await grantCredits(b, 1, "t", { refType: "t", refId: "g" });
    const c = await consume(b, "m");
    vi.setSystemTime(new Date("2026-05-15T00:00:00Z"));
    await prisma.$transaction((tx) => refundCredit(tx, c));
    vi.setSystemTime(new Date("2026-06-20T00:00:00Z")); // original lot lapsed (May 30) but refund lot still valid
    expect(await getBalance(b)).toBe(1);
    vi.setSystemTime(new Date("2026-08-14T00:00:01Z"));
    expect(await getBalance(b)).toBe(0);
  });

  it("getLedger returns newest first, honours limit, serialises dates", async () => {
    await grantCredits(b, 2, "t", { refType: "t", refId: "g" });
    await consume(b, "m1");
    const l = await getLedger(b);
    expect(l.map((e) => e.reason)).toEqual(["consume", "grant"]);
    expect(l[1]!.expiresAt).toMatch(/Z$/);
    expect(l[0]!.expiresAt).toBeNull();
    expect(await getLedger(b, 1)).toHaveLength(1);
  });
});

describe("rollover and expiry job", () => {
  it("credits roll over up to day 90 then lapse; job writes off remainder once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(t0);
    // createdAt is DB-assigned (now()), so seed explicit timestamps for a deterministic timeline.
    await prisma.creditLedgerEntry.create({ data: { businessId: b, delta: 10, reason: "grant", refType: "t", refId: "g", expiresAt: new Date(t0.getTime() + 90 * 86_400_000), createdAt: t0 } });
    await prisma.creditLedgerEntry.create({ data: { businessId: b, delta: -1, reason: "consume", refType: "m", refId: "a", createdAt: new Date(t0.getTime() + 86_400_000) } });
    vi.setSystemTime(new Date(t0.getTime() + 89 * 86_400_000));
    expect(await getBalance(b)).toBe(9);
    const at = new Date(t0.getTime() + 91 * 86_400_000);
    vi.setSystemTime(at);
    expect(await getBalance(b)).toBe(0);
    expect(await expireLapsedCredits(at)).toBeGreaterThanOrEqual(1);
    const exp = await prisma.creditLedgerEntry.findMany({ where: { businessId: b, reason: "expire" } });
    expect(exp).toHaveLength(1);
    expect(exp[0]!.delta).toBe(-9);
    await expireLapsedCredits(at);
    expect(await prisma.creditLedgerEntry.count({ where: { businessId: b, reason: "expire" } })).toBe(1);
    expect(await getBalance(b)).toBe(0);
  });

  it("does not write off a fully consumed or unexpired lot", async () => {
    await grantCredits(b, 1, "t", { refType: "t", refId: "g" });
    await consume(b, "a");
    await expireLapsedCredits(new Date(Date.now() + 200 * 86_400_000));
    expect(await prisma.creditLedgerEntry.count({ where: { businessId: b, reason: "expire" } })).toBe(0);
  });
});

describe("plans", () => {
  it("seedPlans is idempotent and repairs drifted rows without touching subscriptions", async () => {
    await seedPlans();
    await prisma.plan.update({ where: { code: "starter" }, data: { monthlyCredits: 1, name: "Drift" } });
    await startFreePlan(b);
    await seedPlans();
    await seedPlans();
    expect(await prisma.plan.count({ where: { code: { in: ["free", "starter", "pro"] } } })).toBe(3);
    const starter = await getPlan("starter");
    expect(starter).toMatchObject({ name: "Starter", monthlyCredits: 60, monthlyPricePaise: 99_900 });
    expect(await prisma.subscription.count({ where: { businessId: b } })).toBe(1);
    const plans = await listPlans();
    expect(plans.map((p) => p.code).slice(0, 3)).toEqual(["free", "starter", "pro"]);
    expect(plans.find((p) => p.code === "pro")!.monthlyCredits).toBe(250);
  });
  it("getPlan unknown -> not_found; toPlanView tolerates non-array features", async () => {
    await expect(getPlan("nope-zzz")).rejects.toMatchObject({ code: "not_found" });
    expect(toPlanView({ code: "x", name: "X", monthlyPricePaise: 5n, monthlyCredits: 1, annualDiscountBps: 2000, features: { a: 1 } })).toEqual({ code: "x", name: "X", monthlyPricePaise: 5, monthlyCredits: 1, annualDiscountBps: 2000, annualPricePaise: 48, features: [] });
  });
});

describe("subscriptions", () => {
  it("startFreePlan grants free credits once even under concurrent redelivery", async () => {
    await Promise.all([startFreePlan(b), startFreePlan(b), startFreePlan(b)]);
    expect(await getBalance(b)).toBe(10);
    expect(await prisma.subscription.count({ where: { businessId: b } })).toBe(1);
    const s = await getActiveSubscription(b);
    expect(s).toMatchObject({ planCode: "free", status: "active", autoRenew: false });
  });

  it("subscribe: same plan conflicts, switching cancels the old one silently, never autoRenew", async () => {
    const s1 = await subscribe(b, "starter");
    expect(s1.autoRenew).toBe(false);
    await expect(subscribe(b, "starter")).rejects.toMatchObject({ code: "conflict" });
    const s2 = await subscribe(b, "pro");
    expect(s2.planCode).toBe("pro");
    expect(await prisma.subscription.count({ where: { businessId: b, status: "active" } })).toBe(1);
    expect(await prisma.subscription.count({ where: { businessId: b, autoRenew: true } })).toBe(0);
    expect(await events(b, "SubscriptionCancelled")).toBe(0);
    expect(await events(b, "SubscriptionStarted")).toBe(2);
    await expect(subscribe(b, "no-such-plan")).rejects.toMatchObject({ code: "not_found" });
    const p = s2.periodEnd;
    expect(new Date(p).getTime() - new Date(s2.periodStart).getTime()).toBe(30 * 86_400_000);
  });

  it("cancel with no paid plan -> not_found; cancel keeps the plan until the period end (no refund, no new grant), then the lapse job ends it with the event", async () => {
    await expect(cancelSubscription(b)).rejects.toMatchObject({ code: "not_found" });
    await startFreePlan(b);
    await expect(cancelSubscriptionWithQuote(b)).rejects.toMatchObject({ code: "not_found" });
    await subscribe(b, "starter");
    const bal = await getBalance(b);
    const before = (await getActiveSubscription(b))!;
    const q = await cancelSubscriptionWithQuote(b);
    expect(q).toMatchObject({ planCode: "starter", billingInterval: "monthly", refundPaise: 0, effectiveAt: before.periodEnd });
    // still the paid plan, flagged; nothing emitted yet; undo is available (nothing was refunded)
    expect(await getActiveSubscription(b)).toMatchObject({ planCode: "starter", status: "active", cancelAtPeriodEnd: true, cancelUndoable: true, periodEnd: before.periodEnd });
    expect(await getBalance(b)).toBe(bal);
    expect(await events(b, "SubscriptionCancelled")).toBe(0);
    await expect(cancelSubscriptionWithQuote(b)).rejects.toMatchObject({ code: "conflict" });
    // period end: ends, event with the effective date, Free starts (and gets its monthly credits)
    await endLapsedSubscriptions(new Date(new Date(before.periodEnd).getTime() + 1000));
    expect((await getActiveSubscription(b)) === null || (await getActiveSubscription(b))!.planCode === "free").toBe(true);
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: b, type: "SubscriptionCancelled" } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ planCode: "starter", refundPaise: 0, billingInterval: "monthly", effectiveAt: before.periodEnd });
    expect(await prisma.subscription.count({ where: { businessId: b, autoRenew: true } })).toBe(0);
  });

  it("getActiveSubscription ignores periods that ended", async () => {
    await prisma.subscription.create({ data: { businessId: b, planCode: "free", status: "active", periodStart: new Date(Date.now() - 40 * 86_400_000), periodEnd: new Date(Date.now() - 1000), autoRenew: false } });
    expect(await getActiveSubscription(b)).toBeNull();
  });

  it("endLapsedSubscriptions expires lapsed subs, re-grants free monthly credits once, is idempotent", async () => {
    await prisma.subscription.create({ data: { businessId: b, planCode: "starter", status: "active", periodStart: new Date(Date.now() - 31 * 86_400_000), periodEnd: new Date(Date.now() - 1000), autoRenew: false } });
    expect(await endLapsedSubscriptions()).toBeGreaterThanOrEqual(1);
    expect(await endLapsedSubscriptions()).toBe(0 + (await countOtherLapsed()));
    const subs = await prisma.subscription.findMany({ where: { businessId: b } });
    expect(subs.map((s) => `${s.planCode}:${s.status}`).sort()).toEqual(["free:active", "starter:expired"]);
    expect(await getBalance(b)).toBe(10);
  });

  it("endLapsedSubscriptions does not start free when another active period exists", async () => {
    await prisma.subscription.create({ data: { businessId: b, planCode: "starter", status: "active", periodStart: new Date(Date.now() - 31 * 86_400_000), periodEnd: new Date(Date.now() - 1000), autoRenew: false } });
    await prisma.subscription.create({ data: { businessId: b, planCode: "pro", status: "active", periodStart: new Date(), periodEnd: new Date(Date.now() + 86_400_000), autoRenew: false } });
    await endLapsedSubscriptions();
    expect(await prisma.subscription.count({ where: { businessId: b, planCode: "free" } })).toBe(0);
    expect(await getBalance(b)).toBe(0);
  });
});

async function countOtherLapsed(): Promise<number> {
  return prisma.subscription.count({ where: { status: "active", periodEnd: { lte: new Date() } } });
}

describe("worker module", () => {
  it("registers BusinessCreated handler and the scheduled jobs", async () => {
    expect(worker.name).toBe("billing");
    expect(Object.keys(worker.handlers ?? {})).toEqual(["BusinessCreated"]);
    expect(worker.jobs!.map((j) => j.name)).toEqual(["billing.end-subscriptions", "billing.annual-credits", "billing.renewal-reminders", "billing.refund-retry", "billing.expire-credits"]);
    await worker.handlers!.BusinessCreated!({ payload: { businessId: b } } as never);
    expect(await getBalance(b)).toBe(10);
    for (const j of worker.jobs!) await j.run();
  });
});
