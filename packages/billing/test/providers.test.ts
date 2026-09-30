import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@cnote/core";
import { cashfree, configuredProvider, getProvider, header, mock, mockSign, razorpay, redact } from "../src/payment-providers";

const rzEnv = { RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "whsec" } as NodeJS.ProcessEnv;
const cfEnv = { CASHFREE_APP_ID: "a", CASHFREE_SECRET_KEY: "sk", NODE_ENV: "test" } as NodeJS.ProcessEnv;
const rzSig = (body: string, secret = "whsec") => createHmac("sha256", secret).update(body).digest("hex");
const cfSig = (ts: string, body: string, secret = "sk") => createHmac("sha256", secret).update(ts + body).digest("base64");
afterEach(() => vi.unstubAllGlobals());
const stubFetch = (res: unknown, ok = true) => {
  const f = vi.fn(async () => ({ ok, status: ok ? 200 : 400, json: async () => res }) as Response);
  vi.stubGlobal("fetch", f);
  return f;
};

describe("razorpay webhook", () => {
  const body = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1", reference_id: "ord-1", amount_paid: 117_882 } }, payment: { entity: { id: "pay_1", amount: 117_882, email: "a@b.c", contact: "+91999", card: { last4: "1111" } } } } });
  it("accepts a valid signature, parses and redacts payer data", () => {
    const p = razorpay(rzEnv).verifyWebhook(body, { "X-Razorpay-Signature": rzSig(body), "x-razorpay-event-id": "evt_1" })!;
    expect(p).toMatchObject({ eventId: "evt_1", outcome: "paid", orderId: "ord-1", providerOrderId: "plink_1", providerPaymentId: "pay_1", amountPaise: 117_882 });
    expect(JSON.stringify(p.redacted)).not.toMatch(/a@b\.c|1111|\+91999/);
  });
  it("rejects invalid, missing, tampered signatures and missing secret", () => {
    const r = razorpay(rzEnv);
    expect(r.verifyWebhook(body, { "x-razorpay-signature": rzSig(body, "other") })).toBeNull();
    expect(r.verifyWebhook(body, {})).toBeNull();
    expect(r.verifyWebhook(body + " ", { "x-razorpay-signature": rzSig(body) })).toBeNull();
    expect(razorpay({} as never).verifyWebhook(body, { "x-razorpay-signature": rzSig(body) })).toBeNull();
  });
  it("valid signature over garbage is a validation error; expiry fails; others ignored; falls back to body hash id", () => {
    const r = razorpay(rzEnv);
    expect(() => r.verifyWebhook("nope", { "x-razorpay-signature": rzSig("nope") })).toThrow(DomainError);
    const exp = JSON.stringify({ event: "payment_link.expired", payload: { payment_link: { entity: { id: "plink_1", notes: { order_id: "ord-2" } } } } });
    expect(r.verifyWebhook(exp, { "x-razorpay-signature": rzSig(exp) })).toMatchObject({ outcome: "failed", orderId: "ord-2" });
    const other = JSON.stringify({ event: "payment.captured", payload: {} });
    const o = r.verifyWebhook(other, { "x-razorpay-signature": rzSig(other) })!;
    expect(o.outcome).toBe("ignored");
    expect(o.eventId).toHaveLength(64);
  });
  it("createOrder posts a payment link with paise amounts", async () => {
    const f = stubFetch({ id: "plink_9", short_url: "https://rzp.io/i/x" });
    const r = await razorpay(rzEnv).createOrder({ orderId: "o1", amountPaise: 117_882, description: "d", customer: { name: "N", email: "e@x.y", phone: "999" }, returnUrl: "https://r", notifyUrl: "n" });
    expect(r).toEqual({ providerOrderId: "plink_9", redirectUrl: "https://rzp.io/i/x" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/payment_links");
    expect(JSON.parse(init.body as string)).toMatchObject({ amount: 117_882, currency: "INR", reference_id: "o1", customer: { contact: "999" } });
  });
  it("errors: not configured, provider rejects, unexpected body", async () => {
    await expect(razorpay({} as never).createOrder({ orderId: "o", amountPaise: 1, description: "d", customer: {}, returnUrl: "", notifyUrl: "" })).rejects.toThrow(/not configured/);
    stubFetch({ error: "x" }, false);
    await expect(razorpay(rzEnv).createOrder({ orderId: "o", amountPaise: 1, description: "d", customer: {}, returnUrl: "", notifyUrl: "" })).rejects.toThrow(/rejected/);
    stubFetch({});
    await expect(razorpay(rzEnv).createOrder({ orderId: "o", amountPaise: 1, description: "d", customer: {}, returnUrl: "", notifyUrl: "" })).rejects.toThrow(/unexpected/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    await expect(razorpay(rzEnv).fetchPayment({ id: "o", providerOrderId: "p" })).rejects.toThrow(/unreachable/);
  });
  it("fetchPayment + refund", async () => {
    stubFetch({ status: "paid", amount_paid: 500, payments: [{ payment_id: "pay_7" }] });
    expect(await razorpay(rzEnv).fetchPayment({ id: "o", providerOrderId: "p" })).toEqual({ status: "paid", providerPaymentId: "pay_7", amountPaise: 500 });
    stubFetch({ status: "expired" });
    expect((await razorpay(rzEnv).fetchPayment({ id: "o", providerOrderId: "p" })).status).toBe("failed");
    stubFetch({ status: "created" });
    expect((await razorpay(rzEnv).fetchPayment({ id: "o", providerOrderId: "p" })).status).toBe("pending");
    expect((await razorpay(rzEnv).fetchPayment({ id: "o", providerOrderId: null })).status).toBe("pending");
    const f = stubFetch({ id: "rfnd_1", status: "processed" });
    expect(await razorpay(rzEnv).refund({ orderId: "o", providerOrderId: "p", providerPaymentId: "pay_1", amountPaise: 100, refundId: "r", reason: "x" })).toEqual({ providerRefundId: "rfnd_1", status: "processed" });
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain("/payments/pay_1/refund");
    await expect(razorpay(rzEnv).refund({ orderId: "o", providerOrderId: "p", providerPaymentId: null, amountPaise: 1, refundId: "r", reason: "x" })).rejects.toThrow();
  });
});

describe("cashfree", () => {
  const body = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", event_time: "t1", data: { order: { order_id: "ord-1" }, payment: { cf_payment_id: 55, payment_amount: 1178.82 }, customer_details: { customer_phone: "999" } } });
  it("verifies timestamp+body HMAC (base64) and converts rupees to paise", () => {
    const c = cashfree(cfEnv);
    const p = c.verifyWebhook(body, { "x-webhook-timestamp": "123", "x-webhook-signature": cfSig("123", body) })!;
    expect(p).toMatchObject({ outcome: "paid", orderId: "ord-1", providerPaymentId: "55", amountPaise: 117_882 });
    expect(JSON.stringify(p.redacted)).not.toContain("999");
    expect(c.verifyWebhook(body, { "x-webhook-timestamp": "124", "x-webhook-signature": cfSig("123", body) })).toBeNull();
    expect(c.verifyWebhook(body, { "x-webhook-timestamp": "123" })).toBeNull();
    expect(cashfree({ CASHFREE_WEBHOOK_SECRET: "w" } as never).verifyWebhook(body, { "x-webhook-timestamp": "123", "x-webhook-signature": cfSig("123", body, "w") })).not.toBeNull();
  });
  it("maps failed and ignored events", () => {
    const c = cashfree(cfEnv);
    const f = JSON.stringify({ type: "PAYMENT_FAILED_WEBHOOK", data: { order: { order_id: "o" }, payment: { cf_payment_id: 1, payment_message: "bank down" } } });
    expect(c.verifyWebhook(f, { "x-webhook-timestamp": "1", "x-webhook-signature": cfSig("1", f) })).toMatchObject({ outcome: "failed", failureReason: "bank down" });
    const d = JSON.stringify({ type: "PAYMENT_USER_DROPPED_WEBHOOK", data: {} });
    expect(c.verifyWebhook(d, { "x-webhook-timestamp": "1", "x-webhook-signature": cfSig("1", d) })!.outcome).toBe("ignored");
  });
  it("createOrder builds the hosted link; needs a 10-digit phone", async () => {
    const f = stubFetch({ cf_order_id: 77, payment_session_id: "sess_1" });
    const r = await cashfree(cfEnv).createOrder({ orderId: "6f2c1c1e-0000-4000-8000-000000000001", amountPaise: 117_882, description: "d", customer: { phone: "+91 98765-43210", email: "e@x.y" }, returnUrl: "r", notifyUrl: "n" });
    expect(r.redirectUrl).toContain("sess_1");
    expect(r.providerOrderId).toBe("77");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ order_amount: 1178.82, customer_details: { customer_phone: "9876543210" } });
    await expect(cashfree(cfEnv).createOrder({ orderId: "o", amountPaise: 1, description: "d", customer: {}, returnUrl: "", notifyUrl: "" })).rejects.toThrow(/phone/);
    stubFetch({});
    await expect(cashfree(cfEnv).createOrder({ orderId: "o", amountPaise: 1, description: "d", customer: { phone: "9876543210" }, returnUrl: "", notifyUrl: "" })).rejects.toThrow(/unexpected/);
    await expect(cashfree({} as never).createOrder({ orderId: "o", amountPaise: 1, description: "d", customer: { phone: "9876543210" }, returnUrl: "", notifyUrl: "" })).rejects.toThrow(/not configured/);
  });
  it("fetchPayment + refund", async () => {
    stubFetch([{ payment_status: "SUCCESS", cf_payment_id: 9, payment_amount: 10 }]);
    expect(await cashfree(cfEnv).fetchPayment({ id: "o", providerOrderId: null })).toEqual({ status: "paid", providerPaymentId: "9", amountPaise: 1000 });
    stubFetch([{ payment_status: "FAILED" }]);
    expect((await cashfree(cfEnv).fetchPayment({ id: "o", providerOrderId: null })).status).toBe("failed");
    stubFetch([]);
    expect((await cashfree(cfEnv).fetchPayment({ id: "o", providerOrderId: null })).status).toBe("pending");
    stubFetch({ cf_refund_id: 3, refund_status: "PENDING" });
    expect(await cashfree(cfEnv).refund({ orderId: "o", providerOrderId: "77", providerPaymentId: "9", amountPaise: 100, refundId: "a-b", reason: "x" })).toEqual({ providerRefundId: "3", status: "pending" });
  });
});

describe("mock + selection", () => {
  it("mock verifies its own HMAC only", () => {
    const m = mock({} as never);
    const b = JSON.stringify({ id: "e1", type: "payment.paid", orderId: "o", paymentId: "p", amountPaise: 5 });
    expect(m.verifyWebhook(b, { "x-mock-signature": mockSign(b) })).toMatchObject({ outcome: "paid", amountPaise: 5 });
    expect(m.verifyWebhook(b, { "x-mock-signature": "bad" })).toBeNull();
    const f = JSON.stringify({ type: "payment.failed" });
    expect(m.verifyWebhook(f, { "x-mock-signature": mockSign(f) })!.outcome).toBe("failed");
    const i = JSON.stringify({ type: "other" });
    expect(m.verifyWebhook(i, { "x-mock-signature": mockSign(i) })!.outcome).toBe("ignored");
  });
  it("mock createOrder/fetch/refund", async () => {
    const m = mock({ SELLER_APP_URL: "http://s" } as never);
    expect((await m.createOrder({ orderId: "o", amountPaise: 1, description: "", customer: {}, returnUrl: "", notifyUrl: "" })).redirectUrl).toBe("http://s/billing/mock-pay?order=o");
    expect((await m.fetchPayment({ id: "o", providerOrderId: null })).status).toBe("pending");
    expect((await m.refund({ orderId: "o", providerOrderId: null, providerPaymentId: null, amountPaise: 1, refundId: "r", reason: "" })).status).toBe("processed");
  });
  it("provider selection and production guard for mock", () => {
    expect(configuredProvider({} as never)).toBe("mock");
    expect(configuredProvider({ PAYMENTS_PROVIDER: "razorpay" } as never)).toBe("razorpay");
    expect(() => configuredProvider({ PAYMENTS_PROVIDER: "paypal" } as never)).toThrow();
    expect(() => getProvider("mock", { NODE_ENV: "production" } as never)).toThrow(/production/);
    expect(getProvider("mock", { NODE_ENV: "production", PAYMENTS_ALLOW_MOCK_IN_PRODUCTION: "1" } as never).name).toBe("mock");
    expect(getProvider("cashfree", cfEnv).name).toBe("cashfree");
    expect(getProvider("razorpay", rzEnv).name).toBe("razorpay");
  });
  it("header() handles Headers and case-insensitive records; redact strips nested payer keys", () => {
    expect(header(new Headers({ "X-A": "1" }), "x-a")).toBe("1");
    expect(header({ "X-A": "1" }, "x-a")).toBe("1");
    expect(header({}, "x-a")).toBeUndefined();
    expect(redact({ a: [{ email: "x", ok: 1 }], vpa: "u@upi" })).toEqual({ a: [{ ok: 1 }] });
  });
});
