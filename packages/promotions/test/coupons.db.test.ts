import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@cnote/db";
import { getBalance } from "@cnote/billing";
import { activateCoupon, computeDiscount, couponPort, createCoupon, expireCoupons, reserveCoupon, releaseReservation, releaseExpiredReservations, redeemCouponTx, listCoupons, listRedemptions, normaliseCode, pauseCoupon, quoteCoupon, randomCode, redeemCoupon, requiresSecondApprover, setGstinLookup, voidRedemption, type CouponInput } from "../src/index";
import { cleanup, DAY, mkBusiness, tag, uid } from "./helpers";

const couponIds: string[] = [];
afterAll(async () => {
  setGstinLookup(null);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: couponIds } } });
  await prisma.couponRedemption.deleteMany({ where: { couponId: { in: couponIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await cleanup();
});

const staff = { staffId: uid() };
const approver = { staffId: uid() };
const mk = async (o: Partial<CouponInput> = {}, live = true) => {
  const c = await createCoupon({ name: "Launch", kind: "percent", percentBps: 2000, validFrom: new Date(Date.now() - DAY), validTo: new Date(Date.now() + DAY), firstPurchaseOnly: false, ...o }, staff);
  couponIds.push(c.id);
  return live ? activateCoupon(c.id, approver.staffId) : c;
};
const q = (code: string, businessId: string, amountPaise = 99_900, extra: object = {}) => quoteCoupon(code, { businessId, planCode: "starter", amountPaise, isFirstPurchase: true, ...extra });

afterEach(() => vi.useRealTimers());

describe("discount maths", () => {
  it("percent honours the cap; flat never exceeds the amount; credits add no discount", () => {
    expect(computeDiscount({ kind: "percent", percentBps: 2000, maxDiscountPaise: null, valuePaise: null, extraCredits: null }, 99_900)).toEqual({ discountPaise: 19_980, creditsBonus: 0 });
    expect(computeDiscount({ kind: "percent", percentBps: 5000, maxDiscountPaise: 10_000n, valuePaise: null, extraCredits: null }, 99_900).discountPaise).toBe(10_000);
    expect(computeDiscount({ kind: "flat", percentBps: null, maxDiscountPaise: null, valuePaise: 500_000n, extraCredits: null }, 99_900).discountPaise).toBe(99_900);
    expect(computeDiscount({ kind: "extra_credits", percentBps: null, maxDiscountPaise: null, valuePaise: null, extraCredits: 25 }, 99_900)).toEqual({ discountPaise: 0, creditsBonus: 25 });
    expect(computeDiscount({ kind: "ad_credit", percentBps: null, maxDiscountPaise: null, valuePaise: 1n, extraCredits: null }, 5)).toEqual({ discountPaise: 0, creditsBonus: 0 });
  });
  it("codes: normalised, random 12 char unambiguous", () => {
    expect(normaliseCode(" ab c-1 ")).toBe("ABC-1");
    const c = randomCode();
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    expect(randomCode()).not.toBe(c);
  });
  it("large-value rule", () => {
    expect(requiresSecondApprover({ kind: "percent", percentBps: 5001, valuePaise: null, extraCredits: null })).toBe(true);
    expect(requiresSecondApprover({ kind: "percent", percentBps: 5000, valuePaise: null, extraCredits: null })).toBe(false);
    expect(requiresSecondApprover({ kind: "flat", percentBps: null, valuePaise: 500_000, extraCredits: null })).toBe(true);
    expect(requiresSecondApprover({ kind: "extra_credits", percentBps: null, valuePaise: null, extraCredits: 200 })).toBe(true);
  });
});

describe("creation and approval", () => {
  it("ad_credit is super_admin only; large coupons need a different approver; codes are unique", async () => {
    await expect(createCoupon({ name: "Ads", kind: "ad_credit", valuePaise: 10_000, validFrom: new Date(), validTo: new Date(Date.now() + DAY) }, staff)).rejects.toMatchObject({ code: "forbidden" });
    const ad = await createCoupon({ name: "Ads", kind: "ad_credit", valuePaise: 10_000, validFrom: new Date(), validTo: new Date(Date.now() + DAY) }, { ...staff, isSuperAdmin: true });
    couponIds.push(ad.id);
    await expect(activateCoupon(ad.id, approver.staffId)).rejects.toMatchObject({ code: "forbidden" });
    const big = await mk({ percentBps: 7000 }, false);
    expect(big.requiresSecondApprover).toBe(true);
    await expect(activateCoupon(big.id, staff.staffId)).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/two-person/) });
    expect(await activateCoupon(big.id, approver.staffId)).toMatchObject({ status: "active", approvedBy: approver.staffId });
    const code = `DUP${tag}`.toUpperCase();
    await mk({ code });
    await expect(mk({ code })).rejects.toMatchObject({ code: "conflict" });
    await expect(createCoupon({ name: "x", kind: "percent", percentBps: 0, validFrom: new Date(), validTo: new Date(Date.now() + DAY) }, staff)).rejects.toMatchObject({ code: "validation" });
    await expect(createCoupon({ name: "x", kind: "flat", validFrom: new Date(), validTo: new Date(Date.now() - DAY) }, staff)).rejects.toMatchObject({ code: "validation" });
    expect((await listCoupons()).length).toBeGreaterThan(0);
  });
  it("pause / resume / expire", async () => {
    const c = await mk();
    await pauseCoupon(c.id);
    await expect(pauseCoupon(c.id)).rejects.toMatchObject({ code: "conflict" });
    await prisma.coupon.update({ where: { id: c.id }, data: { validTo: new Date(Date.now() - 1000) } });
    expect(await expireCoupons()).toBeGreaterThanOrEqual(1);
    expect((await prisma.coupon.findUnique({ where: { id: c.id } }))!.status).toBe("expired");
  });
});

describe("quote", () => {
  it("prices a valid code; one generic message for every kind of bad code (no enumeration)", async () => {
    const b = await mkBusiness(1);
    const c = await mk();
    expect(await q(c.code, b.id)).toMatchObject({ couponId: c.id, discountPaise: 19_980, creditsBonus: 0, terms: expect.stringMatching(/first billing period only/) });
    expect(await q(c.code.toLowerCase(), b.id)).toMatchObject({ couponId: c.id });
    const draft = (await mk({}, false)).code;
    const future = (await mk({ validFrom: new Date(Date.now() + DAY), validTo: new Date(Date.now() + 2 * DAY) })).code;
    const proOnly = (await mk({ planCodes: ["pro"] })).code;
    const bad: Promise<unknown>[] = [
      q("NOSUCHCODE1", b.id), // unknown
      q("!!", b.id), // malformed
      q(draft, b.id), // draft
      q(future, b.id), // not yet valid
      q(proOnly, b.id), // wrong plan
      q(c.code, b.id, 99_900, { planCode: "free" }), // free plan
    ];
    const messages = (await Promise.allSettled(bad)).map((r) => (r.status === "rejected" ? (r.reason as Error).message : "OK"));
    expect(new Set(messages)).toEqual(new Set(["This code is not valid."]));
    await expect(quoteCoupon(c.code, { businessId: b.id, planCode: "starter", amountPaise: 0 })).rejects.toMatchObject({ code: "validation" });
  });
  it("min tier gives an actionable (non-enumerating) message; first-purchase-only; ad_credit never redeemable at checkout", async () => {
    const t0 = await mkBusiness(0);
    const c = await mk();
    await expect(q(c.code, t0.id)).rejects.toMatchObject({ code: "forbidden" });
    const t1 = await mkBusiness(1);
    const first = await mk({ firstPurchaseOnly: true });
    await expect(quoteCoupon(first.code, { businessId: t1.id, planCode: "starter", amountPaise: 99_900, isFirstPurchase: false })).rejects.toMatchObject({ message: "This code is not valid." });
    await expect(quoteCoupon(first.code, { businessId: t1.id, planCode: "starter", amountPaise: 99_900 })).resolves.toMatchObject({ discountPaise: 19_980 }); // inferred: no prior purchase
    const ad = await createCoupon({ name: "Ads", kind: "ad_credit", valuePaise: 10_000, validFrom: new Date(Date.now() - DAY), validTo: new Date(Date.now() + DAY) }, { staffId: staff.staffId, isSuperAdmin: true });
    couponIds.push(ad.id);
    await activateCoupon(ad.id, approver.staffId, { isSuperAdmin: true });
    await expect(q(ad.code, t1.id)).rejects.toMatchObject({ message: "This code is not valid." });
  });
  it("attempts are rate limited per business", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // fixed-window limiter: a real minute/hour boundary mid-test would reset the counter
    const b = await mkBusiness(1);
    let limited = false;
    for (let i = 0; i < 20 && !limited; i++) {
      try {
        await q("WRONGCODE", b.id);
      } catch (e) {
        limited = (e as { code: string }).code === "rate_limited";
      }
    }
    expect(limited).toBe(true);
  });
});

describe("redeem", () => {
  it("applies once, is idempotent per payment order, and emits CouponRedeemed", async () => {
    const b = await mkBusiness(1);
    const c = await mk();
    const quote = await q(c.code, b.id);
    const r = await redeemCoupon(quote.couponId, { businessId: b.id, paymentOrderId: "pay_1" }); // amount comes from the quote snapshot
    expect(r).toMatchObject({ discountPaise: 19_980, creditsGranted: 0, replay: false });
    expect(await redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "pay_1", amountPaise: 99_900 })).toMatchObject({ redemptionId: r.redemptionId, replay: true });
    await expect(redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "pay_2", amountPaise: 99_900 })).rejects.toMatchObject({ code: "validation" }); // per-business limit 1
    expect((await prisma.coupon.findUnique({ where: { id: c.id } }))!.redeemedCount).toBe(1);
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: c.id } })).map((e) => e.type)).toEqual(["CouponRedeemed"]);
    expect((await listRedemptions(c.id)).length).toBe(1);
    await expect(redeemCoupon(c.id, { businessId: (await mkBusiness(1)).id, paymentOrderId: "" })).rejects.toMatchObject({ code: "validation" });
    await expect(redeemCoupon(c.id, { businessId: (await mkBusiness(1)).id, paymentOrderId: "p" })).rejects.toMatchObject({ message: expect.stringMatching(/quote has expired/) });
  });

  it("CONCURRENCY: 12 parallel redemptions by one business succeed exactly once", async () => {
    const b = await mkBusiness(1);
    const c = await mk({ perBusinessLimit: 1 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => redeemCoupon(c.id, { businessId: b.id, paymentOrderId: `par_${i}`, amountPaise: 99_900 })));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await prisma.couponRedemption.count({ where: { couponId: c.id, status: "applied" } }))).toBe(1);
    expect((await prisma.coupon.findUnique({ where: { id: c.id } }))!.redeemedCount).toBe(1);
  });

  it("CONCURRENCY: a capped coupon is never over-redeemed across businesses, then becomes exhausted", async () => {
    const c = await mk({ maxRedemptions: 3 });
    const biz = await Promise.all(Array.from({ length: 10 }, () => mkBusiness(1)));
    const results = await Promise.allSettled(biz.map((b) => redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "x", amountPaise: 99_900 })));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(3);
    const row = await prisma.coupon.findUnique({ where: { id: c.id } });
    expect(row).toMatchObject({ redeemedCount: 3, status: "exhausted" });
    await expect(q(c.code, (await mkBusiness(1)).id)).rejects.toMatchObject({ message: "This code is not valid." });
  });

  it("one per GSTIN: a second business with the same GSTIN cannot redeem", async () => {
    const a = await mkBusiness(1);
    const b = await mkBusiness(1);
    const c = await mk();
    setGstinLookup(async (id) => (id === a.id || id === b.id ? `GST-${tag}` : null));
    try {
      await redeemCoupon(c.id, { businessId: a.id, paymentOrderId: "g1", amountPaise: 99_900 });
      await expect(q(c.code, b.id)).rejects.toMatchObject({ message: "This code is not valid." });
      await expect(redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "g2", amountPaise: 99_900 })).rejects.toMatchObject({ code: "validation" });
    } finally {
      setGstinLookup(null);
    }
  });

  it("extra_credits grants lead credits once (idempotent), and cannot be voided afterwards", async () => {
    const b = await mkBusiness(1);
    const c = await mk({ kind: "extra_credits", percentBps: undefined, extraCredits: 25 });
    const quote = await q(c.code, b.id);
    expect(quote).toMatchObject({ discountPaise: 0, creditsBonus: 25 });
    const before = await getBalance(b.id);
    const r = await redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "cr1" });
    await redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "cr1" }); // replay: still one grant
    expect((await getBalance(b.id)) - before).toBe(25);
    await expect(voidRedemption(r.redemptionId, "x")).rejects.toMatchObject({ code: "conflict" });
  });

  it("void frees the slot (failed checkout), reopens an exhausted coupon, and a voided payment ref cannot be reused", async () => {
    const b = await mkBusiness(1);
    const c = await mk({ maxRedemptions: 1 });
    const r = await redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "v1", amountPaise: 99_900 });
    expect((await prisma.coupon.findUnique({ where: { id: c.id } }))!.status).toBe("exhausted");
    await voidRedemption(r.redemptionId, "payment failed");
    await voidRedemption(r.redemptionId, "again"); // idempotent
    expect(await prisma.coupon.findUnique({ where: { id: c.id } })).toMatchObject({ status: "active", redeemedCount: 0 });
    await expect(redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "v1", amountPaise: 99_900 })).rejects.toMatchObject({ code: "conflict" });
    await expect(redeemCoupon(c.id, { businessId: b.id, paymentOrderId: "v2", amountPaise: 99_900 })).resolves.toMatchObject({ replay: false });
    await expect(voidRedemption(uid(), "x")).rejects.toMatchObject({ code: "not_found" });
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: c.id } })).map((e) => e.type)).toContain("CouponVoided");
  });

  it("refuses a redemption after the coupon is paused or expired", async () => {
    const c = await mk();
    await pauseCoupon(c.id);
    await expect(redeemCoupon(c.id, { businessId: (await mkBusiness(1)).id, paymentOrderId: "p1", amountPaise: 99_900 })).rejects.toMatchObject({ message: "This code is not valid." });
  });

  it("exposes the port billing registers", () => {
    expect(couponPort.quoteCoupon).toBe(quoteCoupon);
    expect(couponPort.redeemCoupon).toBe(redeemCoupon);
  });
});

describe("checkout reservation (security audit M3)", () => {
  const reserve = (couponId: string, businessId: string, ref: string, amountPaise = 99_900) => reserveCoupon(couponId, { businessId, paymentOrderId: ref, planCode: "starter", amountPaise });

  it("N parallel checkouts on a single-use code: exactly one reservation, the rest refused BEFORE any discounted payment", async () => {
    const biz = await Promise.all(Array.from({ length: 8 }, () => mkBusiness(1)));
    const c = await mk({ maxRedemptions: 1 });
    const out = await Promise.allSettled(biz.map((b, i) => reserve(c.id, b.id, `par-${tag}-${i}`)));
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(out.filter((o) => o.status === "rejected")).toHaveLength(7);
    // the held slot also blocks new quotes until it is released
    const loser = biz.find((_, i) => out[i]!.status === "rejected")!;
    await expect(q(c.code, loser.id)).rejects.toMatchObject({ message: "This code is not valid." });
    const winnerIdx = out.findIndex((o) => o.status === "fulfilled");
    await releaseReservation(`par-${tag}-${winnerIdx}`);
    await expect(q(c.code, loser.id)).resolves.toMatchObject({ discountPaise: 19_980 });
  });

  it("same business retry: a new checkout replaces its own abandoned reservation; parallel checkouts still allow exactly one redemption", async () => {
    const b = await mkBusiness(1);
    const c = await mk({ perBusinessLimit: 1 });
    // abandoned checkout, then a retry with the same code is NOT refused: the old reservation is released
    await reserve(c.id, b.id, `rt-${tag}-1`);
    await expect(q(c.code, b.id)).resolves.toMatchObject({ discountPaise: 19_980 });
    await reserve(c.id, b.id, `rt-${tag}-2`);
    const rows = await prisma.couponRedemption.findMany({ where: { couponId: c.id, businessId: b.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status).sort()).toEqual(["reserved", "voided"]);
    expect(await prisma.domainEvent.count({ where: { aggregateId: c.id, type: "CouponVoided", payload: { path: ["reason"], equals: "superseded_by_new_checkout" } } })).toBe(1);
    // the abandoned order paying late cannot redeem (its reservation was released and the new one holds the only slot)
    await expect(prisma.$transaction((tx) => redeemCouponTx(tx, c.id, { businessId: b.id, paymentOrderId: `rt-${tag}-1`, amountPaise: 99_900 }))).rejects.toMatchObject({ code: "conflict" });
    await expect(prisma.$transaction((tx) => redeemCouponTx(tx, c.id, { businessId: b.id, paymentOrderId: `rt-${tag}-2`, amountPaise: 99_900 }))).resolves.toMatchObject({ replay: false });
  });

  it("same business: N parallel checkouts leave one live reservation and only one can be redeemed", async () => {
    const b = await mkBusiness(1);
    const c = await mk({ perBusinessLimit: 1 });
    await Promise.all([0, 1, 2, 3].map((i) => reserve(c.id, b.id, `pp-${tag}-${i}`)));
    expect(await prisma.couponRedemption.count({ where: { couponId: c.id, businessId: b.id, status: "reserved" } })).toBe(1);
    const out = await Promise.allSettled([0, 1, 2, 3].map((i) => prisma.$transaction((tx) => redeemCouponTx(tx, c.id, { businessId: b.id, paymentOrderId: `pp-${tag}-${i}`, amountPaise: 99_900 }))));
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.couponRedemption.count({ where: { couponId: c.id, businessId: b.id, status: "applied" } })).toBe(1);
  });

  it("same GSTIN across businesses: one reservation", async () => {
    const a = await mkBusiness(1);
    const b = await mkBusiness(1);
    const c = await mk();
    setGstinLookup(async (id) => (id === a.id || id === b.id ? `GST-RES-${tag}` : null));
    try {
      const out = await Promise.allSettled([reserve(c.id, a.id, `g-${tag}-a`), reserve(c.id, b.id, `g-${tag}-b`)]);
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    } finally {
      setGstinLookup(null);
    }
  });

  it("redeemCouponTx consumes the reservation in the caller's transaction and grants nothing itself; rollback leaves it reserved", async () => {
    const b = await mkBusiness(1);
    const c = await mk({ kind: "extra_credits", percentBps: undefined, extraCredits: 12, maxRedemptions: 1 });
    await reserveCoupon(c.id, { businessId: b.id, paymentOrderId: `tx-${tag}`, amountPaise: 99_900 });
    const before = await getBalance(b.id);
    await expect(prisma.$transaction(async (tx) => {
      await redeemCouponTx(tx, c.id, { businessId: b.id, paymentOrderId: `tx-${tag}` });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await prisma.couponRedemption.findFirstOrThrow({ where: { couponId: c.id } })).status).toBe("reserved");
    const r = await prisma.$transaction((tx) => redeemCouponTx(tx, c.id, { businessId: b.id, paymentOrderId: `tx-${tag}` }));
    expect(r).toMatchObject({ creditsGranted: 12, replay: false });
    expect(await getBalance(b.id)).toBe(before); // billing grants, in the same tx, from the returned amount
    expect(await prisma.coupon.findUnique({ where: { id: c.id } })).toMatchObject({ redeemedCount: 1, status: "exhausted" });
  });

  it("an expired reservation is released by the job and the slot reopens; a late redeem is re-checked against the cap", async () => {
    const a = await mkBusiness(1);
    const b = await mkBusiness(1);
    const c = await mk({ maxRedemptions: 1 });
    const past = new Date(Date.now() - 3 * 3_600_000);
    await reserveCoupon(c.id, { businessId: a.id, paymentOrderId: `ex-${tag}-a`, amountPaise: 99_900 }, past);
    expect(await releaseExpiredReservations()).toBeGreaterThanOrEqual(1);
    await reserve(c.id, b.id, `ex-${tag}-b`); // b takes the freed slot
    // a's late payment can no longer take it
    await expect(prisma.$transaction((tx) => redeemCouponTx(tx, c.id, { businessId: a.id, paymentOrderId: `ex-${tag}-a`, amountPaise: 99_900 }))).rejects.toMatchObject({ code: "conflict" });
    await expect(prisma.$transaction((tx) => redeemCouponTx(tx, c.id, { businessId: b.id, paymentOrderId: `ex-${tag}-b`, amountPaise: 99_900 }))).resolves.toMatchObject({ replay: false });
  });
});
