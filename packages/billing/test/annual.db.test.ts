// ADR-005: annual plans, pro-rated refund on cancel, idempotent cancellation, renewal reminders. Real Postgres, mock provider.
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMonths, cancelSubscriptionWithQuote, completeMockPayment, endLapsedSubscriptions, getActiveSubscription, getBalance, getCreditLots, grantDueAnnualCredits,
  handlePaymentWebhook, listBusinessRefunds, listPlans, previewCancellation, quoteCheckout, refundBackoffMs, refundDisplayStatus, REFUND_MAX_ATTEMPTS, retryDueRefunds,
  sendRenewalReminders, seedPlans, startCheckout, subscribe, annualRefundPaise, undoCancellation,
} from "../src";
import { mockSign } from "../src/payment-providers";

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

describe("cancelling an annual plan (access until the month counted as used ends)", () => {
  it("refunds the unused full months now (GST included), keeps the plan active until the end of the used month, then ends it with the v2 event", async () => {
    const { b, orderId, total, sub } = await buyAnnual();
    await ageSubscription(sub.id, 4); // 5th month in progress -> 5 months used, 7 unused
    const start = (await prisma.subscription.findUnique({ where: { id: sub.id } }))!.periodStart;
    const preview = await previewCancellation(b);
    const q = await cancelSubscriptionWithQuote(b, { reason: "too_expensive" });
    const accessEnd = addMonths(start, 5).toISOString();
    expect(q).toMatchObject({ planCode: "pro", billingInterval: "annual", unusedMonths: 7, refundPaise: annualRefundPaise(total, 7), creditsKept: 250, effectiveAt: accessEnd });
    expect(preview).toMatchObject({ refundPaise: q.refundPaise, unusedMonths: 7, creditsKept: 250, effectiveAt: accessEnd });
    expect(new Date(q.creditLots[0]!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 80 * DAY);

    // refund went through the provider now, with a credit note; the mock confirms immediately
    const refunds = await prisma.paymentRefund.findMany({ where: { paymentOrderId: orderId } });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0]!.amountPaise)).toBe(q.refundPaise);
    expect(refunds[0]).toMatchObject({ status: "processed", autoRetry: true, attempts: 1 });
    expect(refunds[0]!.creditNoteId).not.toBeNull();
    expect(await events(orderId, "RefundCompleted")).toBe(1);

    // access continues: still Pro, flagged, period shortened to the used months, no more monthly grants, cannot be undone (money went back)
    const active = (await getActiveSubscription(b))!;
    expect(active).toMatchObject({ planCode: "pro", cancelAtPeriodEnd: true, cancelUndoable: false, periodEnd: accessEnd });
    const row = (await prisma.subscription.findUnique({ where: { id: sub.id } }))!;
    expect(row).toMatchObject({ status: "active", nextGrantAt: null, cancelReason: "too_expensive", cancelUnusedMonths: 7 });
    expect(Number(row.cancelRefundPaise)).toBe(q.refundPaise);
    expect(await events(b, "SubscriptionCancelled")).toBe(0);
    expect(await getBalance(b)).toBe(250);
    expect(await grantDueAnnualCredits(new Date(Date.now() + 400 * DAY))).toBeGreaterThanOrEqual(0);
    expect(await getBalance(b)).toBe(250);
    await expect(sendRenewalReminders(new Date(new Date(accessEnd).getTime() - DAY))).resolves.toBeGreaterThanOrEqual(0);
    expect(await events(b, "SubscriptionRenewalDue")).toBe(0); // a cancelled plan is never reminded to renew

    // before the end nothing changes; at the end the lapse job ends it exactly once, emits the event and starts Free
    expect(await endLapsedSubscriptions(new Date(new Date(accessEnd).getTime() - 1000))).toBeGreaterThanOrEqual(0);
    expect((await getActiveSubscription(b))!.planCode).toBe("pro");
    await endLapsedSubscriptions(new Date(new Date(accessEnd).getTime() + 1000));
    await endLapsedSubscriptions(new Date(new Date(accessEnd).getTime() + 2000));
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: b, type: "SubscriptionCancelled" } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.version).toBe(2);
    expect(ev[0]!.payload).toMatchObject({ billingInterval: "annual", refundPaise: q.refundPaise, unusedMonths: 7, reason: "too_expensive", subscriptionId: sub.id, effectiveAt: accessEnd });
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("expired");
  });

  it("cancelling straight after buying still counts the first month as used; access runs to the end of that month", async () => {
    const { b, total, sub } = await buyAnnual();
    const q = await cancelSubscriptionWithQuote(b);
    expect(q.unusedMonths).toBe(11);
    expect(q.refundPaise).toBe(annualRefundPaise(total, 11));
    expect(q.effectiveAt).toBe(addMonths(sub.periodStart, 1).toISOString());
  });

  it("is idempotent: a second or concurrent cancel changes nothing (one refund, still one scheduled end)", async () => {
    const { b, orderId } = await buyAnnual();
    const results = await Promise.allSettled([cancelSubscriptionWithQuote(b), cancelSubscriptionWithQuote(b), cancelSubscriptionWithQuote(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "conflict")).toBe(true);
    await expect(cancelSubscriptionWithQuote(b)).rejects.toMatchObject({ code: "conflict" });
    await expect(previewCancellation(b)).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.paymentRefund.count({ where: { paymentOrderId: orderId } })).toBe(1);
  });

  it("never refunds more than what is left of the payment", async () => {
    const { b, orderId, total, sub } = await buyAnnual();
    await ageSubscription(sub.id, 1);
    const { refundPayment } = await import("../src");
    await refundPayment(orderId, total - 100, "goodwill");
    expect((await cancelSubscriptionWithQuote(b)).refundPaise).toBe(100);
  });

  it("monthly plans and dev (unpaid) annual subscriptions refund nothing; monthly keeps the plan to its period end", async () => {
    const b1 = await biz();
    await subscribe(b1, "starter");
    const end = (await getActiveSubscription(b1))!.periodEnd;
    expect(await previewCancellation(b1)).toMatchObject({ billingInterval: "monthly", refundPaise: 0, unusedMonths: 0, effectiveAt: end });
    const q1 = await cancelSubscriptionWithQuote(b1);
    expect(q1).toMatchObject({ refundPaise: 0, effectiveAt: end });
    expect(await getActiveSubscription(b1)).toMatchObject({ planCode: "starter", cancelAtPeriodEnd: true, periodEnd: end });
    await endLapsedSubscriptions(new Date(new Date(end).getTime() + 1000));
    const ev = await prisma.domainEvent.findFirst({ where: { aggregateId: b1, type: "SubscriptionCancelled" } });
    expect(ev!.payload).toMatchObject({ refundPaise: 0, billingInterval: "monthly", reason: null, effectiveAt: end });

    const b2 = await biz();
    await subscribe(b2, "pro");
    await prisma.subscription.updateMany({ where: { businessId: b2, planCode: "pro" }, data: { billingInterval: "annual" } });
    expect((await cancelSubscriptionWithQuote(b2)).refundPaise).toBe(0);
  });

  it("an unknown reason is dropped, and there is nothing to cancel on the free plan", async () => {
    const b = await biz();
    await subscribe(b, "starter");
    await cancelSubscriptionWithQuote(b, { reason: "<script>" });
    expect((await prisma.subscription.findFirst({ where: { businessId: b, planCode: "starter" } }))!.cancelReason).toBeNull();
    const f = await biz();
    await subscribe(f, "free");
    await expect(previewCancellation(f)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("undo cancellation (one tap, before the end date)", () => {
  it("restores the plan when nothing was refunded; it can then be cancelled again", async () => {
    const b = await biz();
    await subscribe(b, "starter");
    await expect(undoCancellation(b)).rejects.toMatchObject({ code: "conflict" }); // not cancelled yet
    await cancelSubscriptionWithQuote(b, { reason: "other" });
    const undone = await undoCancellation(b);
    expect(undone).toMatchObject({ planCode: "starter", cancelAtPeriodEnd: false, cancelUndoable: false });
    expect(await prisma.subscription.findUnique({ where: { id: undone.id } })).toMatchObject({ cancelAtPeriodEnd: false, cancelledAt: null, cancelReason: null });
    // the period end passes: nothing was cancelled, so the lapse job emits no cancellation
    await endLapsedSubscriptions(new Date(new Date(undone.periodEnd).getTime() + 1000));
    expect(await events(b, "SubscriptionCancelled")).toBe(0);
  });
  it("cancel again after undo works", async () => {
    const b = await biz();
    await subscribe(b, "starter");
    await cancelSubscriptionWithQuote(b);
    await undoCancellation(b);
    await expect(cancelSubscriptionWithQuote(b)).resolves.toMatchObject({ planCode: "starter" });
  });
  it("is refused once a refund was started (the money already went back)", async () => {
    const { b } = await buyAnnual();
    await cancelSubscriptionWithQuote(b);
    await expect(undoCancellation(b)).rejects.toMatchObject({ code: "validation" });
    expect((await getActiveSubscription(b))!.cancelAtPeriodEnd).toBe(true);
  });
  it("buying the same plan again while it is scheduled to end is allowed (explicit re-purchase)", async () => {
    const { b } = await buyAnnual();
    await cancelSubscriptionWithQuote(b);
    await expect(startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro", interval: "annual" })).resolves.toMatchObject({ provider: "mock" });
  });
});

describe("refund retry (billing.refund-retry): backoff, idempotency, dead letter", () => {
  // retryDueRefunds is global: park whatever a test left retrying so tests cannot pick up each other's rows
  afterEach(async () => { await prisma.paymentRefund.updateMany({ where: { status: "retrying" }, data: { status: "failed", nextAttemptAt: null } }); });
  const cashfree = () => { process.env.CASHFREE_APP_ID = "a"; process.env.CASHFREE_SECRET_KEY = "s"; };
  const failing = () => vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
  /** Buys annual, switches the order to cashfree so the (stubbed) HTTP provider is used for the refund. */
  async function cancelledWithFailingProvider() {
    const bought = await buyAnnual();
    await prisma.paymentOrder.update({ where: { id: bought.orderId }, data: { provider: "cashfree" } });
    cashfree();
    vi.stubGlobal("fetch", failing());
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = await cancelSubscriptionWithQuote(bought.b);
    return { ...bought, q, err };
  }

  it("a provider failure does not fail the cancellation: the refund row retries, and the seller is told it is processing", async () => {
    const { b, orderId, q, err } = await cancelledWithFailingProvider();
    err.mockRestore();
    expect(q.refundPaise).toBeGreaterThan(0);
    expect((await getActiveSubscription(b))!.cancelAtPeriodEnd).toBe(true);
    const row = (await prisma.paymentRefund.findFirst({ where: { paymentOrderId: orderId } }))!;
    expect(row).toMatchObject({ status: "retrying", attempts: 1, autoRetry: true, providerRefundId: null });
    expect(row.lastError).toMatch(/rejected/);
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    expect((await listBusinessRefunds(b))[0]).toMatchObject({ status: "processing", amountPaise: q.refundPaise });
    expect(refundDisplayStatus(row)).toBe("processing");
    expect((await prisma.paymentOrder.findUnique({ where: { id: orderId } }))!.status).toBe("paid"); // not refunded until the provider accepts
  });

  it("retries only when due, sends the row id as the provider idempotency key, then confirms; a second run does nothing", async () => {
    const { b, orderId, q, err } = await cancelledWithFailingProvider();
    err.mockRestore();
    const row = (await prisma.paymentRefund.findFirst({ where: { paymentOrderId: orderId } }))!;
    expect((await retryDueRefunds(new Date())).attempted).toBe(0); // not due yet
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ cf_refund_id: "cfr_1", refund_status: "SUCCESS" }) }) as Response);
    vi.stubGlobal("fetch", ok);
    const due = new Date(row.nextAttemptAt!.getTime() + 1000);
    const r = await retryDueRefunds(due);
    expect(r.succeeded).toBeGreaterThanOrEqual(1);
    const keys = (ok.mock.calls as unknown as [string, RequestInit][]).map((c) => (c[1].headers as Record<string, string>)["x-idempotency-key"]);
    expect(keys).toContain(row.id);
    const done = (await prisma.paymentRefund.findUnique({ where: { id: row.id } }))!;
    expect(done).toMatchObject({ status: "processed", providerRefundId: "cfr_1", attempts: 2, lastError: null, nextAttemptAt: null });
    expect(done.creditNoteId).not.toBeNull();
    expect(Number(done.amountPaise)).toBe(q.refundPaise);
    expect(await events(orderId, "RefundCompleted")).toBe(1);
    expect((await listBusinessRefunds(b))[0]!.status).toBe("completed");
    expect((await retryDueRefunds(new Date(due.getTime() + 3_600_000))).attempted).toBe(0);
    expect(keys.filter((k) => k === row.id)).toHaveLength(1);
  });

  it("two workers never send the same refund twice (lease), and the backoff doubles", async () => {
    const { orderId, err } = await cancelledWithFailingProvider();
    const row = (await prisma.paymentRefund.findFirst({ where: { paymentOrderId: orderId } }))!;
    const fetchMock = failing();
    vi.stubGlobal("fetch", fetchMock);
    const due = new Date(row.nextAttemptAt!.getTime() + 1000);
    const [x, y] = await Promise.all([retryDueRefunds(due), retryDueRefunds(due)]);
    expect(x.attempted + y.attempted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = (await prisma.paymentRefund.findUnique({ where: { id: row.id } }))!;
    expect(after).toMatchObject({ status: "retrying", attempts: 2 });
    // attempt 1 -> 10 min, attempt 2 -> 20 min after the failed retry
    expect(row.nextAttemptAt!.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(refundBackoffMs(1) - 5000);
    expect(after.nextAttemptAt!.getTime() - due.getTime()).toBe(refundBackoffMs(2));
    expect(refundBackoffMs(2)).toBe(2 * refundBackoffMs(1));
    expect(refundBackoffMs(20)).toBe(12 * 3_600_000); // capped
    err.mockRestore();
  });

  it("after the maximum attempts the refund is dead-lettered: event + loud alert, no more retries", async () => {
    const { b, orderId, err } = await cancelledWithFailingProvider();
    let now = new Date(Date.now() + 60_000);
    let dead = 0;
    for (let i = 0; i < REFUND_MAX_ATTEMPTS + 2; i++) {
      const r = await retryDueRefunds(now);
      dead += r.dead;
      now = new Date(now.getTime() + 13 * 3_600_000);
    }
    expect(dead).toBeGreaterThanOrEqual(1);
    const row = (await prisma.paymentRefund.findFirst({ where: { paymentOrderId: orderId } }))!;
    expect(row).toMatchObject({ status: "dead", attempts: REFUND_MAX_ATTEMPTS, nextAttemptAt: null });
    expect(await events(orderId, "RefundDeadLettered")).toBe(1);
    expect(err.mock.calls.some((c) => String(c[0]).includes("ALERT: refund"))).toBe(true);
    expect((await listBusinessRefunds(b))[0]!.status).toBe("attention");
    expect((await retryDueRefunds(new Date(now.getTime() + 86_400_000))).attempted).toBe(0);
    err.mockRestore();
  });

  it("provider accepted but not final (pending) is 'initiated'; the provider webhook then completes it and emits RefundCompleted once", async () => {
    const { b, orderId } = await buyAnnual();
    await prisma.paymentOrder.update({ where: { id: orderId }, data: { provider: "cashfree" } });
    cashfree();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ cf_refund_id: "cfr_9", refund_status: "PENDING" }) }) as Response));
    await cancelSubscriptionWithQuote(b);
    const row = (await prisma.paymentRefund.findFirst({ where: { paymentOrderId: orderId } }))!;
    expect(row).toMatchObject({ status: "pending", providerRefundId: "cfr_9" });
    expect((await listBusinessRefunds(b))[0]!.status).toBe("initiated");
    expect(await events(orderId, "RefundCompleted")).toBe(0);
    const body = JSON.stringify({ id: `t_rf_${row.id}`, type: "refund.processed", providerRefundId: "cfr_9", refundId: row.id });
    await handlePaymentWebhook("mock", body, { "x-mock-signature": mockSign(body) });
    await handlePaymentWebhook("mock", body, { "x-mock-signature": mockSign(body) }); // duplicate delivery
    expect((await prisma.paymentRefund.findUnique({ where: { id: row.id } }))!.status).toBe("processed");
    expect(await events(orderId, "RefundCompleted")).toBe(1);
    expect((await listBusinessRefunds(b))[0]!.status).toBe("completed");
    await prisma.paymentWebhookEvent.deleteMany({ where: { eventId: `t_rf_${row.id}` } });
  });

  it("a provider-reported refund failure dead-letters it; unknown refund notices are ignored", async () => {
    const { orderId, b } = await buyAnnual();
    await prisma.paymentOrder.update({ where: { id: orderId }, data: { provider: "cashfree" } });
    cashfree();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ cf_refund_id: "cfr_7", refund_status: "PENDING" }) }) as Response));
    await cancelSubscriptionWithQuote(b);
    const row = (await prisma.paymentRefund.findFirst({ where: { paymentOrderId: orderId } }))!;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [id, payload] of [[`t_rf_${row.id}_f`, { type: "refund.failed", providerRefundId: "cfr_7" }], ["t_rf_unknown", { type: "refund.processed", providerRefundId: "nope" }]] as const) {
      const body = JSON.stringify({ id, ...payload });
      await handlePaymentWebhook("mock", body, { "x-mock-signature": mockSign(body) });
    }
    err.mockRestore();
    expect((await prisma.paymentRefund.findUnique({ where: { id: row.id } }))!.status).toBe("dead");
    expect(await events(orderId, "RefundDeadLettered")).toBe(1);
    await prisma.paymentWebhookEvent.deleteMany({ where: { eventId: { in: [`t_rf_${row.id}_f`, "t_rf_unknown"] } } });
  });

  it("refundDisplayStatus maps every state to what the seller may be told", () => {
    expect(refundDisplayStatus({ status: "processed", providerRefundId: "x" })).toBe("completed");
    expect(refundDisplayStatus({ status: "pending", providerRefundId: "x" })).toBe("initiated");
    expect(refundDisplayStatus({ status: "pending", providerRefundId: null })).toBe("processing");
    expect(refundDisplayStatus({ status: "retrying", providerRefundId: null })).toBe("processing");
    expect(refundDisplayStatus({ status: "dead", providerRefundId: null })).toBe("attention");
    expect(refundDisplayStatus({ status: "failed", providerRefundId: null })).toBe("attention");
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
