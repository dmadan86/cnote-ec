// ADR-005: annual plans, pro-rated refund on cancel, idempotent cancellation, renewal reminders. Real Postgres, mock provider.
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMonths, cancelSubscriptionWithQuote, completeMockPayment, getActiveSubscription, getBalance, getCreditLots, grantDueAnnualCredits, listPlans,
  previewCancellation, quoteCheckout, sendRenewalReminders, seedPlans, startCheckout, subscribe, annualRefundPaise,
} from "../src";

const created: string[] = [];
async function biz(): Promise<string> {
  const b = await prisma.business.create({ data: { name: `annual-x-${Date.now()}-${Math.random()}`, registeredAddress: { line1: "1 Road", city: "Pune", stateCode: "29" } } });
  created.push(b.id);
  return b.id;
}
const env0 = { ...process.env };
beforeAll(async () => { await seedPlans(); });
beforeEach(() => { process.env.PAYMENTS_PROVIDER = "mock"; process.env.PLATFORM_STATE_CODE = "29"; });
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...env0 }; });
afterAll(async () => {
  const orders = (await prisma.paymentOrder.findMany({ where: { businessId: { in: created } }, select: { id: true } })).map((o) => o.id);
  await prisma.paymentRefund.deleteMany({ where: { paymentOrderId: { in: orders } } });
  await prisma.invoice.deleteMany({ where: { businessId: { in: created } } });
  await prisma.paymentOrder.deleteMany({ where: { businessId: { in: created } } });
  await prisma.paymentWebhookEvent.deleteMany({ where: { provider: "mock", eventId: { in: orders.map((o) => `mock_evt_${o}_paid`) } } });
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: created } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: created } } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: created } }, { aggregateId: { in: orders } }] } });
  await prisma.business.deleteMany({ where: { id: { in: created } } });
});

const events = (id: string, type: string) => prisma.domainEvent.count({ where: { aggregateId: id, type } });
const DAY = 86_400_000;

/** Buys the annual Pro plan through the mock gateway (real webhook path). */
async function buyAnnual(plan = "pro") {
  const b = await biz();
  const c = await startCheckout({ businessId: b }, { purpose: "subscription", planCode: plan, interval: "annual" });
  await completeMockPayment({ businessId: b }, c.orderId);
  const sub = (await prisma.subscription.findFirst({ where: { businessId: b, status: "active", planCode: plan } }))!;
  return { b, orderId: c.orderId, total: c.totalPaise, sub };
}
/** Pretends the annual period started `months` months (+ a few days) ago. */
async function ageSubscription(subId: string, months: number, extraDays = 3) {
  const start = new Date(addMonths(new Date(), -months).getTime() - extraDays * DAY);
  await prisma.subscription.update({ where: { id: subId }, data: { periodStart: start, periodEnd: addMonths(start, 12), nextGrantAt: addMonths(start, months + 1) } });
}

describe("annual checkout", () => {
  it("quotes 12 months less the configured discount with GST on top, and the invoice matches the charge", async () => {
    const b = await biz();
    const plans = await listPlans();
    const pro = plans.find((p) => p.code === "pro")!;
    const q = await quoteCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro", interval: "annual" });
    expect(q.listPaise).toBe(pro.annualPricePaise);
    expect(q.listPaise).toBe(Math.floor((pro.monthlyPricePaise * 12 * (10_000 - pro.annualDiscountBps)) / 10_000));
    expect(q.gstPaise).toBe(Math.floor((q.taxablePaise * 1800 + 5000) / 10_000));
    expect(q.totalPaise).toBe(q.taxablePaise + q.gstPaise);
    expect(q.description).toMatch(/12 months/);
    const c = await startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro", interval: "annual" });
    const st = await completeMockPayment({ businessId: b }, c.orderId);
    expect(st.status).toBe("paid");
    const inv = await prisma.invoice.findUnique({ where: { paymentOrderId: c.orderId } });
    expect(inv).toMatchObject({ kind: "tax_invoice" });
    expect(Number(inv!.totalPaise)).toBe(c.totalPaise);
    expect(JSON.stringify(inv!.lines)).toMatch(/12 months/);
  });

  it("activates a 12-month period with autoRenew off, grants one month of credits now and the rest monthly", async () => {
    const { b, orderId, sub } = await buyAnnual();
    expect(sub).toMatchObject({ billingInterval: "annual", autoRenew: false, paymentOrderId: orderId });
    expect(sub.periodEnd.getTime()).toBe(addMonths(sub.periodStart, 12).getTime());
    expect(sub.nextGrantAt!.getTime()).toBe(addMonths(sub.periodStart, 1).getTime());
    expect(await getBalance(b)).toBe(250); // one month, not twelve
    expect((await getActiveSubscription(b))!.billingInterval).toBe("annual");

    // not due yet: nothing happens
    expect(await grantDueAnnualCredits()).toBe(0);
    // month 2 falls due: exactly one grant, even when the job runs twice or concurrently
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextGrantAt: new Date(Date.now() - 1000) } });
    const runs = await Promise.all([grantDueAnnualCredits(), grantDueAnnualCredits()]);
    expect(runs[0]! + runs[1]!).toBe(1);
    expect(await getBalance(b)).toBe(500);
    const after = (await prisma.subscription.findUnique({ where: { id: sub.id } }))!;
    expect(after.nextGrantAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await grantDueAnnualCredits()).toBe(0);
    // every grant keeps its own 90-day expiry
    const lots = await getCreditLots(b);
    expect(lots).toHaveLength(2);
  });

  it("the last monthly grant clears nextGrantAt", async () => {
    const { b, sub } = await buyAnnual("starter");
    const lastDue = addMonths(sub.periodStart, 11);
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextGrantAt: lastDue, periodStart: new Date(sub.periodStart.getTime() - 400 * DAY), periodEnd: new Date(Date.now() + 5 * DAY) } });
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextGrantAt: new Date(Date.now() - 1000) } });
    expect(await grantDueAnnualCredits()).toBe(1);
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.nextGrantAt).toBeNull();
    expect(await getBalance(b)).toBe(60 + 60);
  });

  it("buying the same plan again is blocked mid-term, but switching interval or renewing near the end is allowed", async () => {
    const { b, sub } = await buyAnnual();
    await expect(startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro", interval: "annual" })).rejects.toMatchObject({ code: "conflict" });
    await expect(startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro" })).resolves.toMatchObject({ provider: "mock" }); // monthly <-> annual
    await prisma.subscription.update({ where: { id: sub.id }, data: { periodEnd: new Date(Date.now() + 5 * DAY) } });
    await expect(startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro", interval: "annual" })).resolves.toMatchObject({ provider: "mock" });
  });
});

describe("cancelling an annual plan", () => {
  it("refunds the unused full months of what was paid (GST included) through the provider, issues a credit note, emits v2 with the amount, keeps credits", async () => {
    const { b, orderId, total, sub } = await buyAnnual();
    await ageSubscription(sub.id, 4); // 5th month in progress -> 5 months used, 7 unused
    const preview = await previewCancellation(b);
    const q = await cancelSubscriptionWithQuote(b, { reason: "too_expensive" });
    expect(q).toMatchObject({ planCode: "pro", billingInterval: "annual", unusedMonths: 7, refundPaise: annualRefundPaise(total, 7), creditsKept: 250 });
    expect(preview).toMatchObject({ refundPaise: q.refundPaise, unusedMonths: 7, creditsKept: 250, planCode: "pro" });
    expect(q.creditLots).toHaveLength(1);
    expect(new Date(q.creditLots[0]!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 80 * DAY);

    const refunds = await prisma.paymentRefund.findMany({ where: { paymentOrderId: orderId } });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0]!.amountPaise)).toBe(q.refundPaise);
    expect(refunds[0]).toMatchObject({ status: "processed" });
    expect(refunds[0]!.creditNoteId).not.toBeNull();
    expect((await prisma.paymentOrder.findUnique({ where: { id: orderId } }))!.status).toBe("partially_refunded");

    const ev = (await prisma.domainEvent.findMany({ where: { aggregateId: b, type: "SubscriptionCancelled" } }));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.version).toBe(2);
    expect(ev[0]!.payload).toMatchObject({ billingInterval: "annual", refundPaise: q.refundPaise, unusedMonths: 7, reason: "too_expensive", subscriptionId: sub.id });

    expect(await getBalance(b)).toBe(250); // credits kept, no fresh grant
    const now = (await getActiveSubscription(b))!;
    expect(now.planCode).toBe("free");
    expect(new Date(now.periodEnd).getTime()).toBeLessThanOrEqual(Date.now() + 31 * DAY);
  });

  it("cancelling straight after buying still counts the first month as used (credits were granted)", async () => {
    const { b, total } = await buyAnnual();
    const q = await cancelSubscriptionWithQuote(b);
    expect(q.unusedMonths).toBe(11);
    expect(q.refundPaise).toBe(annualRefundPaise(total, 11));
  });

  it("is idempotent: a second or concurrent cancel changes nothing (one event, one refund)", async () => {
    const { b, orderId } = await buyAnnual();
    const results = await Promise.allSettled([cancelSubscriptionWithQuote(b), cancelSubscriptionWithQuote(b), cancelSubscriptionWithQuote(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "not_found")).toBe(true);
    await expect(cancelSubscriptionWithQuote(b)).rejects.toMatchObject({ code: "not_found" });
    expect(await events(b, "SubscriptionCancelled")).toBe(1);
    expect(await prisma.paymentRefund.count({ where: { paymentOrderId: orderId } })).toBe(1);
  });

  it("a failing provider refund is logged and does not undo the cancellation; the failed refund row can be retried", async () => {
    const { b, orderId } = await buyAnnual();
    await prisma.paymentOrder.update({ where: { id: orderId }, data: { provider: "cashfree" } });
    process.env.CASHFREE_APP_ID = "a"; process.env.CASHFREE_SECRET_KEY = "s";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = await cancelSubscriptionWithQuote(b);
    expect(q.refundPaise).toBeGreaterThan(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect((await getActiveSubscription(b))!.planCode).toBe("free");
    expect(await prisma.paymentRefund.count({ where: { paymentOrderId: orderId, status: "failed" } })).toBe(1);
    expect((await prisma.paymentOrder.findUnique({ where: { id: orderId } }))!.status).toBe("paid");
  });

  it("never refunds more than what is left of the payment", async () => {
    const { b, orderId, total, sub } = await buyAnnual();
    await ageSubscription(sub.id, 1);
    const { refundPayment } = await import("../src");
    await refundPayment(orderId, total - 100, "goodwill");
    const q = await cancelSubscriptionWithQuote(b);
    expect(q.refundPaise).toBe(100);
  });

  it("monthly plans and dev (unpaid) subscriptions refund nothing but still cancel", async () => {
    const b1 = await biz();
    await subscribe(b1, "starter");
    expect(await previewCancellation(b1)).toMatchObject({ billingInterval: "monthly", refundPaise: 0, unusedMonths: 0 });
    const q1 = await cancelSubscriptionWithQuote(b1);
    expect(q1.refundPaise).toBe(0);
    const ev = await prisma.domainEvent.findFirst({ where: { aggregateId: b1, type: "SubscriptionCancelled" } });
    expect(ev!.payload).toMatchObject({ refundPaise: 0, billingInterval: "monthly", reason: null });

    const b2 = await biz();
    await subscribe(b2, "pro");
    await prisma.subscription.updateMany({ where: { businessId: b2, planCode: "pro" }, data: { billingInterval: "annual" } }); // annual flag without a payment
    expect((await cancelSubscriptionWithQuote(b2)).refundPaise).toBe(0);
  });

  it("an unknown reason is dropped, and there is nothing to cancel on the free plan", async () => {
    const b = await biz();
    await subscribe(b, "starter");
    await cancelSubscriptionWithQuote(b, { reason: "<script>" });
    const ev = await prisma.domainEvent.findFirst({ where: { aggregateId: b, type: "SubscriptionCancelled" } });
    expect((ev!.payload as { reason: string | null }).reason).toBeNull();
    await expect(previewCancellation(b)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("renewal reminders (auto-renew stays off)", () => {
  it("asks once, shortly before a paid period ends, and never charges or extends anything", async () => {
    const b = await biz();
    await subscribe(b, "starter");
    await sendRenewalReminders(); // other rows in the shared test DB may fire; this business has 30 days left
    expect(await events(b, "SubscriptionRenewalDue")).toBe(0);
    const sub = (await prisma.subscription.findFirst({ where: { businessId: b, planCode: "starter", status: "active" } }))!;
    await prisma.subscription.update({ where: { id: sub.id }, data: { periodEnd: new Date(Date.now() + 2 * DAY) } });
    expect(await sendRenewalReminders()).toBeGreaterThanOrEqual(1);
    await sendRenewalReminders(); // second run: the period is already marked as reminded
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: b, type: "SubscriptionRenewalDue" } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ businessId: b, planCode: "starter", billingInterval: "monthly", subscriptionId: sub.id });
    const after = (await prisma.subscription.findUnique({ where: { id: sub.id } }))!;
    expect(after.autoRenew).toBe(false);
    expect(after.status).toBe("active");
    expect(await prisma.paymentOrder.count({ where: { businessId: b } })).toBe(0);
  });

  it("annual plans get two weeks of notice; the free plan gets none", async () => {
    const { b, sub } = await buyAnnual("starter");
    await prisma.subscription.update({ where: { id: sub.id }, data: { periodEnd: new Date(Date.now() + 10 * DAY) } });
    await sendRenewalReminders();
    expect(await events(b, "SubscriptionRenewalDue")).toBe(1);
    const f = await biz();
    await subscribe(f, "free");
    await prisma.subscription.updateMany({ where: { businessId: f }, data: { periodEnd: new Date(Date.now() + DAY) } });
    await sendRenewalReminders();
    expect(await events(f, "SubscriptionRenewalDue")).toBe(0);
  });
});
