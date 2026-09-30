import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSubscriptionWithQuote, completeMockPayment, couponPortFromModule, CREDIT_PACKS, failOrder, fulfilOrder, getBalance, getActiveSubscription, getInvoicePdf, getPaymentOrderDetail,
  getPaymentStatus, handlePaymentWebhook, listBusinessPayments, listCreditPacks, listInvoices, listPaymentOrders, quoteCheckout, refundForCancellation, refundPayment,
  registerPaymentPurpose, setCouponPort, setInvoiceDocStore, startCheckout, subscribe, seedPlans,
} from "../src";
import { issueInvoiceTx, nextInvoiceNumber } from "../src/invoices";
import { mockSign } from "../src/payment-providers";
import { decodeRef } from "../src/payments";

const created: string[] = [];
async function biz(o: { gstin?: string; stateCode?: string } = {}): Promise<string> {
  const b = await prisma.business.create({
    data: { name: `pay-x-${Date.now()}-${Math.random()}`, gstin: o.gstin ? o.gstin.slice(0, 2) + Math.random().toString(36).slice(2, 15).toUpperCase().padEnd(13, "0") : undefined, registeredAddress: { line1: "1 Road", city: "Pune", stateCode: o.stateCode ?? "29" } },
  });
  created.push(b.id);
  return b.id;
}
const env0 = { ...process.env };
beforeAll(async () => { await seedPlans(); });
beforeEach(() => { process.env.PAYMENTS_PROVIDER = "mock"; process.env.PLATFORM_STATE_CODE = "29"; });
afterEach(() => { setCouponPort(null); setInvoiceDocStore(null); vi.unstubAllGlobals(); process.env = { ...env0 }; });
afterAll(async () => {
  const orders = (await prisma.paymentOrder.findMany({ where: { businessId: { in: created } }, select: { id: true } })).map((o) => o.id);
  await prisma.paymentRefund.deleteMany({ where: { paymentOrderId: { in: orders } } });
  await prisma.invoice.deleteMany({ where: { businessId: { in: created } } });
  await prisma.paymentOrder.deleteMany({ where: { businessId: { in: created } } });
  await prisma.paymentWebhookEvent.deleteMany({ where: { provider: "mock", eventId: { startsWith: "t_" } } });
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: created } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: created } } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: created } }, { aggregateId: { in: orders } }] } });
  await prisma.business.deleteMany({ where: { id: { in: created } } });
  await prisma.invoiceSequence.deleteMany({ where: { series: { in: ["CN/2098-99", "CR/2098-99"] } } });
});
const events = (id: string, type: string) => prisma.domainEvent.count({ where: { aggregateId: id, type } });
const send = (order: string, extra: Record<string, unknown> = {}, id = `t_${order}_paid`) => {
  const body = JSON.stringify({ id, type: "payment.paid", orderId: order, paymentId: `pay_${order}`, ...extra });
  return handlePaymentWebhook("mock", body, { "x-mock-signature": mockSign(body) });
};

describe("checkout + fulfilment", () => {
  it("credit pack: intra-state GST, webhook fulfils once, invoice matches, event emitted", async () => {
    const b = await biz();
    const q = await quoteCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    expect(q).toMatchObject({ taxablePaise: 39_900, gstPaise: 7182, totalPaise: 47_082, cgstPaise: 3591, sgstPaise: 3591, igstPaise: 0 });
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    expect(c.redirectUrl).toContain(`/billing/mock-pay?order=${c.orderId}`);
    expect((await prisma.paymentOrder.findUnique({ where: { id: c.orderId } }))!.status).toBe("pending");
    const r = await send(c.orderId, { amountPaise: c.totalPaise });
    expect(r).toEqual({ status: 200 });
    expect(await getBalance(b)).toBe(20);
    const o = await prisma.paymentOrder.findUnique({ where: { id: c.orderId }, include: { invoice: true } });
    expect(o!.status).toBe("paid");
    expect(o!.fulfilledAt).not.toBeNull();
    expect(o!.invoice!.totalPaise).toBe(o!.totalPaise);
    expect(o!.invoice!.number).toMatch(/^CN\/\d\d-\d\d\/\d{6}$/);
    expect(o!.invoice!.number.length).toBeLessThanOrEqual(16);
    expect(await events(c.orderId, "PaymentSucceeded")).toBe(1);
  });

  it("inter-state buyer gets IGST", async () => {
    const b = await biz({ gstin: "27AAPFU0939F1ZV" });
    const q = await quoteCheckout({ businessId: b }, { purpose: "subscription", planCode: "starter" });
    expect(q).toMatchObject({ igstPaise: 17_982, cgstPaise: 0, sgstPaise: 0, placeOfSupply: "27" });
  });

  it("same event twice -> one fulfilment; concurrent webhooks -> one fulfilment; replay flagged duplicate", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_50" });
    const rs = await Promise.all([1, 2, 3, 4].map(() => send(c.orderId)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await getBalance(b)).toBe(50);
    expect(await prisma.invoice.count({ where: { paymentOrderId: c.orderId } })).toBe(1);
    expect(await events(c.orderId, "PaymentSucceeded")).toBe(1);
    expect(await send(c.orderId)).toEqual({ status: 200, duplicate: true });
    // a different event id for the same payment (e.g. razorpay + cashfree style redelivery) still fulfils nothing new
    expect(await send(c.orderId, {}, "t_other_id")).toEqual({ status: 200 });
    expect(await getBalance(b)).toBe(50);
    expect((await fulfilOrder(c.orderId)).fulfilled).toBe(false);
  });

  it("invalid signature -> 401 and nothing stored; bad provider / malformed body -> 400", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    const body = JSON.stringify({ id: "t_bad", type: "payment.paid", orderId: c.orderId });
    expect(await handlePaymentWebhook("mock", body, { "x-mock-signature": "nope" })).toEqual({ status: 401 });
    expect(await prisma.paymentWebhookEvent.count({ where: { eventId: "t_bad" } })).toBe(0);
    expect(await handlePaymentWebhook("paypal", body, {})).toEqual({ status: 400 });
    expect(await handlePaymentWebhook("mock", "garbage", { "x-mock-signature": mockSign("garbage") })).toEqual({ status: 400 });
    expect(await getBalance(b)).toBe(0);
  });

  it("amount mismatch never fulfils", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    await send(c.orderId, { amountPaise: 1 });
    const o = await prisma.paymentOrder.findUnique({ where: { id: c.orderId } });
    expect(o).toMatchObject({ status: "failed", failureReason: "amount_mismatch", fulfilledAt: null });
    expect(await getBalance(b)).toBe(0);
    // a later correct payment still succeeds
    await send(c.orderId, { amountPaise: c.totalPaise }, "t_retry");
    expect(await getBalance(b)).toBe(20);
  });

  it("subscription checkout activates the plan (real path); dev subscribe guarded when a real gateway is configured", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro" });
    await completeMockPayment({ businessId: b }, c.orderId);
    expect((await getActiveSubscription(b))?.planCode).toBe("pro");
    expect(await getBalance(b)).toBe(250);
    await expect(startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro" })).rejects.toMatchObject({ code: "conflict" });
    process.env.PAYMENTS_PROVIDER = "razorpay";
    await expect(subscribe(b, "starter")).rejects.toMatchObject({ code: "validation" });
    await expect(startCheckout({ businessId: b }, { purpose: "subscription", planCode: "free" })).rejects.toMatchObject({ code: "validation" });
  });

  it("failure event -> PaymentFailed once; unknown order is logged, not fatal; ignored events fine", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    const body = JSON.stringify({ id: "t_f1", type: "payment.failed", orderId: c.orderId, reason: "declined" });
    await handlePaymentWebhook("mock", body, { "x-mock-signature": mockSign(body) });
    expect(await failOrder(c.orderId, "again")).toBe(false);
    expect(await events(c.orderId, "PaymentFailed")).toBe(1);
    const unk = JSON.stringify({ id: "t_unk", type: "payment.paid", orderId: "00000000-0000-4000-8000-000000000000" });
    expect(await handlePaymentWebhook("mock", unk, { "x-mock-signature": mockSign(unk) })).toEqual({ status: 200 });
    expect((await prisma.paymentWebhookEvent.findFirst({ where: { eventId: "t_unk" } }))!.error).toBe("unknown_order");
    const ign = JSON.stringify({ id: "t_ign", type: "something" });
    expect(await handlePaymentWebhook("mock", ign, { "x-mock-signature": mockSign(ign) })).toEqual({ status: 200 });
    const o = await completeMockPayment({ businessId: b }, c.orderId, "failed");
    expect(o.status).toBe("failed");
    const paid = await completeMockPayment({ businessId: b }, c.orderId);
    expect(paid.status).toBe("paid");
  });

  it("infrastructure error while fulfilling propagates (provider retries) and records the error, then reprocesses", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    await prisma.paymentOrder.update({ where: { id: c.orderId }, data: { purposeRef: "credits_nope" } });
    await expect(send(c.orderId, {}, "t_boom")).rejects.toThrow();
    expect((await prisma.paymentWebhookEvent.findFirst({ where: { eventId: "t_boom" } }))!.error).toContain("Credit pack");
    await prisma.paymentOrder.update({ where: { id: c.orderId }, data: { purposeRef: "credits_20" } });
    expect(await send(c.orderId, {}, "t_boom")).toEqual({ status: 200 });
    expect(await getBalance(b)).toBe(20);
  });

  it("custom purpose handler (ad top-up) and missing handler", async () => {
    const b = await biz();
    const mk = (purpose: string) => prisma.paymentOrder.create({ data: { businessId: b, purpose, purposeRef: "x", provider: "mock", amountPaise: 10_000n, gstPaise: 1800n, totalPaise: 11_800n } });
    const o = await mk("ad_topup_test");
    await expect(fulfilOrder(o.id)).rejects.toThrow(/No fulfilment handler/);
    const seen = vi.fn(async () => ({ description: "Ad wallet top-up", sac: "998365" }));
    registerPaymentPurpose("ad_topup_test", seen);
    expect((await fulfilOrder(o.id)).invoice!.number).toBeTruthy();
    expect(seen).toHaveBeenCalledOnce();
    const inv = await prisma.invoice.findUnique({ where: { paymentOrderId: o.id } });
    expect((inv!.lines as { sac: string }[])[0]!.sac).toBe("998365");
    await expect(fulfilOrder("00000000-0000-4000-8000-000000000000")).rejects.toThrow();
  });
});

describe("coupon port", () => {
  it("quotes via the port, applies discount before GST, grants bonus credits, redeems once", async () => {
    const b = await biz();
    const quote = vi.fn(async () => ({ discountPaise: 9_900, creditsBonus: 5, couponId: "cpn-1" }));
    const redeem = vi.fn(async () => ({}));
    setCouponPort({ quote, redeem });
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20", couponCode: "SAVE" });
    expect(quote).toHaveBeenCalledWith("SAVE", { businessId: b, planCode: undefined, amountPaise: 39_900 });
    const o = await prisma.paymentOrder.findUnique({ where: { id: c.orderId } });
    expect(o).toMatchObject({ amountPaise: 30_000n, gstPaise: 5400n, totalPaise: 35_400n, discountPaise: 9_900n, couponCode: "SAVE" });
    expect(decodeRef(o!.purposeRef)).toEqual({ ref: "credits_20", couponId: "cpn-1", creditsBonus: 5 });
    await Promise.all([send(c.orderId), send(c.orderId, {}, "t_again")]);
    expect(await getBalance(b)).toBe(25);
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(redeem).toHaveBeenCalledWith("cpn-1", { businessId: b, paymentOrderId: c.orderId });
  });
  it("coupon without a registered port is refused; a throwing quote propagates; 100% discount refused; redeem failure is non-fatal", async () => {
    const b = await biz();
    await expect(quoteCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20", couponCode: "X" })).rejects.toMatchObject({ code: "validation" });
    setCouponPort({ quote: async () => { throw new Error("expired"); }, redeem: async () => ({}) });
    await expect(startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20", couponCode: "X" })).rejects.toThrow("expired");
    setCouponPort({ quote: async () => ({ discountPaise: 10_000_000, creditsBonus: 0, couponId: "c" }), redeem: async () => ({}) });
    await expect(quoteCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20", couponCode: "X" })).rejects.toMatchObject({ code: "validation" });
    setCouponPort({ quote: async () => ({ discountPaise: 100, creditsBonus: 0, couponId: "c" }), redeem: async () => { throw new Error("db"); } });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20", couponCode: "X" });
    await send(c.orderId);
    expect(await getBalance(b)).toBe(20);
    err.mockRestore();
  });
  it("couponPortFromModule uses typeof guards", async () => {
    expect(couponPortFromModule({})).toBeNull();
    expect(couponPortFromModule({ quoteCoupon: 1, redeemCoupon: () => 1 })).toBeNull();
    expect(couponPortFromModule(undefined)).toBeNull();
    const p = couponPortFromModule({ quoteCoupon: async () => ({ discountPaise: 1, creditsBonus: 0, couponId: "z" }), redeemCoupon: async () => "ok" })!;
    expect((await p.quote("a", { businessId: "b", amountPaise: 1 })).couponId).toBe("z");
    expect(await p.redeem("z", { businessId: "b", paymentOrderId: "o" })).toBe("ok");
  });
});

describe("refunds + credit notes", () => {
  async function paid(packId = "credits_50") {
    const b = await biz({ gstin: "27AAPFU0939F1ZV" });
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId });
    await completeMockPayment({ businessId: b }, c.orderId);
    return { b, id: c.orderId, total: c.totalPaise };
  }
  it("partial then full refund: credit notes sum to the refund, statuses progress, over-refund blocked", async () => {
    const { b, id, total } = await paid();
    const r1 = await refundPayment(id, 10_000, "goodwill", "staff-1");
    expect(r1.creditNoteNumber).toMatch(/^CR\/\d\d-\d\d\/\d{6}$/);
    expect((await prisma.paymentOrder.findUnique({ where: { id } }))!.status).toBe("partially_refunded");
    await expect(refundPayment(id, total, "too much")).rejects.toMatchObject({ code: "validation" });
    await refundPayment(id, total - 10_000, "rest");
    expect((await prisma.paymentOrder.findUnique({ where: { id } }))!.status).toBe("refunded");
    const notes = await prisma.invoice.findMany({ where: { businessId: b, kind: "credit_note" } });
    expect(notes).toHaveLength(2);
    expect(notes.reduce((a, n) => a + Number(n.totalPaise), 0)).toBe(total);
    for (const n of notes) {
      expect(n.igstPaise).toBeGreaterThan(0n);
      expect(n.taxablePaise + n.cgstPaise + n.sgstPaise + n.igstPaise).toBe(n.totalPaise);
      expect(n.refInvoiceId).not.toBeNull();
    }
    expect(await events(id, "PaymentRefunded")).toBe(2);
    expect(await prisma.paymentRefund.count({ where: { paymentOrderId: id, status: "processed" } })).toBe(2);
    await expect(refundPayment(id, 1, "x")).rejects.toMatchObject({ code: "conflict" });
  });
  it("concurrent refunds cannot exceed the amount paid", async () => {
    const { id, total } = await paid("credits_20");
    const half = Math.floor(total * 0.6);
    const res = await Promise.allSettled([refundPayment(id, half, "a"), refundPayment(id, half, "b")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const sum = (await prisma.paymentRefund.findMany({ where: { paymentOrderId: id, status: { not: "failed" } } })).reduce((a, r) => a + Number(r.amountPaise), 0);
    expect(sum).toBeLessThanOrEqual(total);
  });
  it("validation + unpaid + provider failure", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    await expect(refundPayment(c.orderId, 100, "x")).rejects.toMatchObject({ code: "conflict" });
    await expect(refundPayment(c.orderId, 0, "x")).rejects.toMatchObject({ code: "validation" });
    await expect(refundPayment(c.orderId, 1, " ")).rejects.toMatchObject({ code: "validation" });
    await expect(refundPayment("00000000-0000-4000-8000-000000000000", 1, "x")).rejects.toMatchObject({ code: "not_found" });
    await completeMockPayment({ businessId: b }, c.orderId);
    await prisma.paymentOrder.update({ where: { id: c.orderId }, data: { provider: "cashfree" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    process.env.CASHFREE_APP_ID = "a"; process.env.CASHFREE_SECRET_KEY = "s";
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(refundPayment(c.orderId, 100, "x")).rejects.toThrow(/rejected/);
    err.mockRestore();
    expect(await prisma.paymentRefund.count({ where: { paymentOrderId: c.orderId, status: "failed" } })).toBe(1);
    expect((await prisma.paymentOrder.findUnique({ where: { id: c.orderId } }))!.status).toBe("paid");
  });
  it("annual pro-rata cancellation refunds via the payment path", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro" });
    await completeMockPayment({ businessId: b }, c.orderId);
    await refundForCancellation(b, { subscriptionId: "s", planCode: "pro", refundPaise: 0 });
    await refundForCancellation(b, { subscriptionId: "s", planCode: "pro", refundPaise: 149_950 }); // half of 2,999
    const rf = await prisma.paymentRefund.findMany({ where: { paymentOrderId: c.orderId } });
    expect(rf).toHaveLength(1);
    expect(Number(rf[0]!.amountPaise)).toBe(Math.floor((Number(c.totalPaise) * 149_950) / 299_900));
    // nothing paid -> nothing refunded; monthly cancel path (refund 0) is a no-op
    const b2 = await biz();
    await subscribe(b2, "starter");
    await refundForCancellation(b2, { subscriptionId: "s", planCode: "starter", refundPaise: 100 });
    const q = await cancelSubscriptionWithQuote(b2);
    expect(q.refundPaise).toBe(0);
  });
});

describe("invoice numbering + access", () => {
  it("N parallel invoices get 1..N with no gaps or duplicates; rollback releases the number", async () => {
    const b = await biz();
    const at = new Date("2099-01-05T10:00:00Z"); // FY 2098-99: private to this test
    const issue = (fail = false) =>
      prisma.$transaction(async (tx) => {
        const v = await issueInvoiceTx(tx, { kind: "tax_invoice", businessId: b, at, recipient: { name: "n", address: "a", stateCode: "29" }, lines: [{ description: "x", sac: "998314", quantity: 1, unitPaise: 1000, gstRateBps: 1800 }] });
        if (fail) throw new Error("rollback");
        return v.number;
      });
    await expect(issue(true)).rejects.toThrow("rollback");
    const nums = await Promise.all(Array.from({ length: 12 }, () => issue()));
    const n = nums.map((x) => Number(x.split("/")[2])).sort((a, c) => a - c);
    expect(n).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(nums[0]).toMatch(/^CN\/98-99\//);
    expect((await prisma.invoiceSequence.findUnique({ where: { series: "CN/2098-99" } }))!.lastNumber).toBe(12);
    await expect(prisma.$transaction((tx) => issueInvoiceTx(tx, { kind: "tax_invoice", businessId: b, recipient: { name: "n", address: "", stateCode: null }, lines: [] }))).rejects.toThrow(/at least one line/);
    expect(await prisma.$transaction((tx) => nextInvoiceNumber(tx, "credit_note", "2098-99"))).toBe("CR/98-99/000001");
  });
  it("PDF access: owner or staff only; cache store used; list scoped", async () => {
    const { b, id } = await (async () => {
      const b = await biz();
      const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
      await completeMockPayment({ businessId: b }, c.orderId);
      return { b, id: c.orderId };
    })();
    const other = await biz();
    const inv = (await listInvoices({ businessId: b }))[0]!;
    expect(inv.paymentOrderId).toBe(id);
    expect(await listInvoices({ businessId: other })).toHaveLength(0);
    expect((await listInvoices({ staff: true }, { businessId: b, limit: 5 })).length).toBe(1);
    expect((await listInvoices({ staff: true })).length).toBeGreaterThan(0);
    await expect(listInvoices({ businessId: "" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(getInvoicePdf({ businessId: other }, inv.id)).rejects.toMatchObject({ code: "not_found" });
    const store = new Map<string, Uint8Array>();
    setInvoiceDocStore({ put: async (k, v) => void store.set(k, v), get: async (k) => store.get(k) ?? null });
    const pdf = await getInvoicePdf({ businessId: b }, inv.id);
    expect(pdf.filename).toMatch(/\.pdf$/);
    expect(Buffer.from(pdf.bytes.slice(0, 4)).toString()).toBe("%PDF");
    await new Promise((r) => setTimeout(r, 50));
    expect(store.size).toBe(1);
    expect((await getInvoicePdf({ staff: true }, inv.id)).bytes).toBe(store.values().next().value);
    expect((await prisma.invoice.findUnique({ where: { id: inv.id } }))!.documentKey).toContain("invoices/");
  });
  it("reads: status (owner only), listings, detail with webhook log, packs", async () => {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    await send(c.orderId);
    expect((await getPaymentStatus({ businessId: b }, c.orderId, { sync: true })).status).toBe("paid");
    await expect(getPaymentStatus({ businessId: await biz() }, c.orderId)).rejects.toMatchObject({ code: "not_found" });
    expect((await listBusinessPayments(b)).length).toBe(1);
    expect((await listPaymentOrders({ status: "paid", purpose: "credit_pack", provider: "mock", businessId: b })).length).toBe(1);
    const d = await getPaymentOrderDetail(c.orderId);
    expect(d.events.length).toBe(1);
    expect(d.order.invoiceId).not.toBeNull();
    await expect(getPaymentOrderDetail("00000000-0000-4000-8000-000000000000")).rejects.toThrow();
    expect(listCreditPacks()).toHaveLength(CREDIT_PACKS.length);
    await expect(quoteCheckout({ businessId: b }, { purpose: "credit_pack", packId: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });
  it("sync reconciles a late webhook from the provider; mock is disabled in production", async () => {
    const b = await biz();
    process.env.PAYMENTS_PROVIDER = "razorpay";
    process.env.RAZORPAY_KEY_ID = "k"; process.env.RAZORPAY_KEY_SECRET = "s";
    const f = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (String(url).endsWith("/payment_links") ? { id: "plink_sync", short_url: "https://rzp.io/i/s" } : { status: "paid", amount_paid: 47_082, payments: [{ payment_id: "pay_sync" }] }),
    }) as Response);
    vi.stubGlobal("fetch", f);
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20", });
    expect(c.redirectUrl).toBe("https://rzp.io/i/s");
    expect((await getPaymentStatus({ businessId: b }, c.orderId)).status).toBe("pending");
    expect((await getPaymentStatus({ businessId: b }, c.orderId, { sync: true })).status).toBe("paid");
    expect(await getBalance(b)).toBe(20);
    process.env.NODE_ENV = "production";
    await expect(completeMockPayment({ businessId: b }, c.orderId)).rejects.toMatchObject({ code: "forbidden" });
    process.env.PAYMENTS_PROVIDER = "mock";
    await expect(startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" })).rejects.toThrow(/production/);
  });
  it("provider create failure marks the order failed", async () => {
    const b = await biz();
    process.env.PAYMENTS_PROVIDER = "razorpay"; // not configured
    delete process.env.RAZORPAY_KEY_ID;
    await expect(startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" })).rejects.toThrow(/not configured/);
    expect((await prisma.paymentOrder.findFirst({ where: { businessId: b } }))!.failureReason).toBe("provider_create_failed");
  });
});

describe("annual cancel end to end", () => {
  async function annual() {
    const b = await biz();
    const c = await startCheckout({ businessId: b }, { purpose: "subscription", planCode: "pro" });
    await completeMockPayment({ businessId: b }, c.orderId);
    const now = Date.now();
    await prisma.subscription.updateMany({ where: { businessId: b, planCode: "pro", status: "active" }, data: { periodStart: new Date(now - 30 * 86_400_000), periodEnd: new Date(now + 335 * 86_400_000) } });
    return { b, id: c.orderId };
  }
  it("cancelling an annual period refunds through the provider and issues a credit note", async () => {
    const { b, id } = await annual();
    const q = await cancelSubscriptionWithQuote(b);
    expect(q.refundPaise).toBeGreaterThan(0);
    const rf = await prisma.paymentRefund.findMany({ where: { paymentOrderId: id } });
    expect(rf).toHaveLength(1);
    expect(rf[0]!.creditNoteId).not.toBeNull();
  });
  it("a failing provider refund is logged and does not fail the cancellation", async () => {
    const { b, id } = await annual();
    await prisma.paymentOrder.update({ where: { id }, data: { provider: "cashfree" } });
    process.env.CASHFREE_APP_ID = "a"; process.env.CASHFREE_SECRET_KEY = "s";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const q = await cancelSubscriptionWithQuote(b);
    expect(q.refundPaise).toBeGreaterThan(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it("status sync tolerates provider errors", async () => {
    const b = await biz();
    process.env.PAYMENTS_PROVIDER = "razorpay";
    process.env.RAZORPAY_KEY_ID = "k"; process.env.RAZORPAY_KEY_SECRET = "s";
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (String(u).endsWith("/payment_links") ? ({ ok: true, status: 200, json: async () => ({ id: "p", short_url: "u" }) } as Response) : Promise.reject(new Error("down")))));
    const c = await startCheckout({ businessId: b }, { purpose: "credit_pack", packId: "credits_20" });
    expect((await getPaymentStatus({ businessId: b }, c.orderId, { sync: true })).status).toBe("pending");
  });
});
