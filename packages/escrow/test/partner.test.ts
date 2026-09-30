import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "@cnote/core";
import { CashfreePartner, MockPartner, RazorpayRoutePartner, configuredPartnerName, getEscrowPartner, isPartnerName, setEscrowPartner } from "../src/partner";
import { hmac } from "../src/partner/util";

const ESC = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
afterEach(() => { setEscrowPartner(null); delete process.env.ESCROW_PARTNER; delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; delete process.env.CASHFREE_CLIENT_ID; delete process.env.ESCROW_WEBHOOK_SECRET; });

describe("factory", () => {
  it("defaults to mock, honours env, rejects unknown", () => {
    expect(configuredPartnerName()).toBe("mock");
    expect(getEscrowPartner().name).toBe("mock");
    process.env.ESCROW_PARTNER = "cashfree";
    expect(getEscrowPartner().name).toBe("cashfree");
    process.env.ESCROW_PARTNER = "razorpay_route";
    expect(getEscrowPartner().name).toBe("razorpay_route");
    process.env.ESCROW_PARTNER = "nope";
    expect(() => configuredPartnerName()).toThrow(DomainError);
    expect(isPartnerName("mock")).toBe(true);
    expect(isPartnerName("x")).toBe(false);
  });
  it("override wins for its own name", () => {
    const m = new MockPartner();
    setEscrowPartner(m);
    expect(getEscrowPartner()).toBe(m);
    expect(getEscrowPartner("mock")).toBe(m);
    expect(getEscrowPartner("cashfree")).not.toBe(m);
  });
});

describe("mock partner", () => {
  const m = new MockPartner();
  it("collect is deterministic and idempotent", async () => {
    const req = { escrowId: ESC, orderId: ESC, amountPaise: 100, buyer: { businessId: ESC }, expiresAt: new Date() };
    const a = await m.createCollect(req);
    expect(await m.createCollect(req)).toBe(a);
    expect(a.partnerRef).toBe("mock_va_aaaaaaaa1111");
  });
  it("transfers are idempotent by transfer id, statement records them, bad amount rejected", async () => {
    const r = { transferId: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", escrowId: ESC, amountPaise: 500, beneficiaryBusinessId: ESC, purpose: "seller_payout" as const };
    const a = await m.releasePayout(r);
    expect(await m.releasePayout(r)).toEqual(a);
    expect(a.status).toBe("settled");
    const rf = await m.refund({ ...r, transferId: "cccccccc-1111-4111-8111-cccccccccccc", purpose: "buyer_refund" });
    expect(rf.partnerRef).toMatch(/^mock_rf_/);
    const st = await m.fetchStatement({ from: new Date(0), to: new Date(Date.now() + 1000) });
    expect(st.map((s) => s.kind)).toEqual(expect.arrayContaining(["payout", "refund"]));
    await expect(m.releasePayout({ ...r, transferId: "dddddddd-1111-4111-8111-dddddddddddd", amountPaise: 0 })).rejects.toThrow(DomainError);
    m.pushStatement({ partnerRef: "x", escrowRef: null, kind: "collect", amountPaise: 1, at: new Date().toISOString() });
    m.reset();
    expect(await m.fetchStatement({ from: new Date(0), to: new Date(Date.now() + 1000) })).toEqual([]);
  });
  it("webhooks: signature checked, types parsed, unknown ignored, garbage rejected", () => {
    const { rawBody, headers } = m.simulateCollect(ESC, 777);
    const p = m.verifyWebhook(rawBody, headers)!;
    expect(p).toMatchObject({ type: "collect.captured", escrowId: ESC, amountPaise: 777 });
    expect(m.verifyWebhook(Buffer.from(rawBody), new Headers(headers))).not.toBeNull();
    expect(m.verifyWebhook(rawBody, { "x-escrow-signature": "00" })).toBeNull();
    expect(m.verifyWebhook(rawBody, {})).toBeNull();
    const other = m.event({ type: "something.else" });
    expect(m.verifyWebhook(other.rawBody, other.headers)).toMatchObject({ type: "ignored" });
    const bad = m.event({});
    expect(m.verifyWebhook(bad.rawBody, bad.headers)!.type).toBe("ignored");
    const arr = { rawBody: "[1]", headers: { "x-escrow-signature": m.event({}).headers["x-escrow-signature"]! } };
    expect(m.verifyWebhook(arr.rawBody, arr.headers)).toBeNull();
    const notJson = "not json";
    const sig = hmac(process.env.ESCROW_WEBHOOK_SECRET || "mock-escrow-webhook-secret", notJson, "hex");
    expect(() => m.verifyWebhook(notJson, { "x-escrow-signature": sig })).toThrow(DomainError);
  });
  it("pending payouts are configurable", async () => {
    const pm = new MockPartner({ payoutStatus: "pending" });
    const r = await pm.releasePayout({ transferId: "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", escrowId: ESC, amountPaise: 5, beneficiaryBusinessId: ESC, purpose: "seller_payout" });
    expect(r.status).toBe("pending");
  });
});

describe("real adapters (stubs)", () => {
  it("throw not configured without credentials, not implemented with them", async () => {
    const rz = new RazorpayRoutePartner();
    await expect(rz.createCollect({ escrowId: ESC, orderId: ESC, amountPaise: 1, buyer: { businessId: ESC }, expiresAt: new Date() })).rejects.toThrow(/not configured/);
    await expect(rz.fetchStatement({ from: new Date(), to: new Date() })).rejects.toThrow(/not configured/);
    process.env.RAZORPAY_KEY_ID = "k"; process.env.RAZORPAY_KEY_SECRET = "s";
    const t = { transferId: ESC, escrowId: ESC, amountPaise: 1, beneficiaryBusinessId: ESC, purpose: "seller_payout" as const };
    await expect(rz.releasePayout(t)).rejects.toThrow(/not implemented/);
    await expect(rz.refund(t)).rejects.toThrow(/not implemented/);
    const cf = new CashfreePartner();
    await expect(cf.releasePayout(t)).rejects.toThrow(/not configured/);
    process.env.CASHFREE_CLIENT_ID = "a"; process.env.CASHFREE_CLIENT_SECRET = "b";
    await expect(cf.releasePayout(t)).rejects.toThrow(/not implemented/);
    delete process.env.CASHFREE_CLIENT_SECRET;
  });
  it("razorpay webhook verification and mapping", () => {
    const rz = new RazorpayRoutePartner();
    expect(() => rz.verifyWebhook("{}", {})).toThrow(/not configured/);
    process.env.ESCROW_WEBHOOK_SECRET = "sec";
    const sign = (b: string) => ({ "x-razorpay-signature": hmac("sec", b, "hex") });
    const cap = JSON.stringify({ id: "e1", event: "payment.captured", payload: { payment: { entity: { id: "pay_1", amount: 500, notes: { escrow_id: ESC }, email: "a@b.c" } } } });
    expect(rz.verifyWebhook(cap, sign(cap))).toMatchObject({ eventId: "e1", type: "collect.captured", escrowId: ESC, amountPaise: 500, partnerRef: "pay_1" });
    expect((rz.verifyWebhook(cap, sign(cap))!.redacted as { payload: { payment: { entity: object } } }).payload.payment.entity).not.toHaveProperty("email");
    expect(rz.verifyWebhook(cap, { "x-razorpay-signature": "bad" })).toBeNull();
    for (const [ev, type] of [["payout.processed", "payout.settled"], ["payout.failed", "payout.failed"], ["payout.reversed", "payout.failed"]] as const) {
      const b = JSON.stringify({ event: ev, payload: { payout: { entity: { id: "po_1", reference_id: ESC, amount: 9 } } } });
      expect(rz.verifyWebhook(b, sign(b))).toMatchObject({ type, payoutId: ESC });
    }
    const other = JSON.stringify({ event: "x" });
    expect(rz.verifyWebhook(other, sign(other))!.type).toBe("ignored");
  });
  it("cashfree webhook verification and mapping", () => {
    const cf = new CashfreePartner();
    process.env.ESCROW_WEBHOOK_SECRET = "sec";
    const sign = (b: string) => ({ "x-webhook-timestamp": "123", "x-webhook-signature": hmac("sec", `123${b}`, "base64") });
    const pay = JSON.stringify({ event_id: "c1", type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: ESC }, payment: { cf_payment_id: 9, payment_amount: 12.5 } } });
    expect(cf.verifyWebhook(pay, sign(pay))).toMatchObject({ eventId: "c1", type: "collect.captured", escrowId: ESC, amountPaise: 1250, partnerRef: "9" });
    expect(cf.verifyWebhook(pay, { "x-webhook-timestamp": "123", "x-webhook-signature": "no" })).toBeNull();
    expect(cf.verifyWebhook(pay, {})).toBeNull();
    for (const [t, type] of [["TRANSFER_SUCCESS", "payout.settled"], ["TRANSFER_FAILED", "payout.failed"], ["TRANSFER_REVERSED", "payout.failed"]] as const) {
      const b = JSON.stringify({ type: t, data: { transfer: { transfer_id: ESC, cf_transfer_id: "t" } } });
      expect(cf.verifyWebhook(Buffer.from(b), sign(b))).toMatchObject({ type, payoutId: ESC });
    }
    const noAmt = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: ESC }, payment: {} } });
    expect(cf.verifyWebhook(noAmt, sign(noAmt))!.amountPaise).toBeUndefined();
    const other = JSON.stringify({ type: "Z" });
    expect(cf.verifyWebhook(other, sign(other))!.type).toBe("ignored");
  });
});
