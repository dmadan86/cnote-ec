import { prisma } from "@cnote/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adjustAdWallet, creditTopUp, getAdWalletBalanceTx, debitSpend, expireLapsedAdPromo, getAdWalletBalance, getAdWalletLedger, getAdWalletState, getNonAdRevenuePaise,
  grantAdPromoCredit, refundAdWalletToSource, refundInvalidClick,
} from "../src";

let biz: string;
let other: string;
const uniq = `adwallet-${Date.now()}`;

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: uniq } })).id;
  other = (await prisma.business.create({ data: { name: uniq + "-o" } })).id;
});
afterAll(async () => {
  await prisma.adTopUp.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.adWalletEntry.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: [biz, other] } } });
  await prisma.business.deleteMany({ where: { id: { in: [biz, other] } } });
});

describe("ad wallet (DB)", () => {
  it("top-up is idempotent on the payment ref and validates amounts", async () => {
    const a = await creditTopUp(biz, 50_000, "manual:bank-1");
    const b = await creditTopUp(biz, 50_000, "manual:bank-1");
    expect(b.duplicate).toBe(true);
    expect(b.entryId).toBe(a.entryId);
    expect(await getAdWalletBalance(biz)).toBe(50_000);
    await expect(creditTopUp(biz, 0, "x")).rejects.toMatchObject({ code: "validation" });
    await expect(creditTopUp(biz, 1.5, "x")).rejects.toMatchObject({ code: "validation" });
    await expect(creditTopUp(biz, 10, "")).rejects.toMatchObject({ code: "validation" });
  });

  it("balance can be read inside a caller transaction", async () => {
    expect(await prisma.$transaction((tx) => getAdWalletBalanceTx(tx, biz))).toBe(await getAdWalletBalance(biz));
  });

  it("top-up with GST writes the invoice row and event once", async () => {
    const gst = { gstPaise: 9000, gstRateBps: 1800, sacCode: "998365", taxType: "IGST" as const, placeOfSupply: "29", invoiceNumber: `INV-${uniq}` };
    const a = await creditTopUp(biz, 50_000, `gw:${uniq}`, { gst });
    const b = await creditTopUp(biz, 50_000, `gw:${uniq}`, { gst });
    expect(a.topUpId).toBeTruthy();
    expect(b).toMatchObject({ duplicate: true, topUpId: a.topUpId });
    expect(await prisma.domainEvent.count({ where: { type: "AdWalletToppedUp", aggregateId: biz } })).toBe(1);
    expect(await getAdWalletBalance(biz)).toBe(100_000);
  });

  it("concurrent debits never overdraw and are idempotent per key", async () => {
    const w = (await prisma.business.create({ data: { name: uniq + "-c" } })).id;
    try {
      await creditTopUp(w, 1000, `c:${w}`);
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => debitSpend(w, 300, { idempotencyKey: `d:${w}:${i}` })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      expect((results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]).every((r) => r.reason.code === "insufficient_credits")).toBe(true);
      expect(await getAdWalletBalance(w)).toBe(100);
      const again = await debitSpend(w, 300, { idempotencyKey: `d:${w}:0` }).catch(() => null);
      expect(again).toMatchObject({ duplicate: true });
      expect(await getAdWalletBalance(w)).toBe(100);
    } finally {
      await prisma.adWalletEntry.deleteMany({ where: { businessId: w } });
      await prisma.business.delete({ where: { id: w } });
    }
  });

  it("allowPartial debits what is left and reports the shortfall; zero balance debits nothing", async () => {
    const w = (await prisma.business.create({ data: { name: uniq + "-p" } })).id;
    try {
      await creditTopUp(w, 500, `p:${w}`);
      const r = await debitSpend(w, 800, { idempotencyKey: `p1:${w}`, allowPartial: true });
      expect(r).toMatchObject({ debitedPaise: 500, shortfallPaise: 300 });
      const z = await debitSpend(w, 800, { idempotencyKey: `p2:${w}`, allowPartial: true });
      expect(z).toMatchObject({ entryId: null, debitedPaise: 0, shortfallPaise: 800 });
      expect(await getAdWalletBalance(w)).toBe(0);
      await expect(debitSpend(w, 0, { idempotencyKey: "k" })).rejects.toMatchObject({ code: "validation" });
      await expect(debitSpend(w, 5, { idempotencyKey: "" })).rejects.toMatchObject({ code: "validation" });
    } finally {
      await prisma.adWalletEntry.deleteMany({ where: { businessId: w } });
      await prisma.business.delete({ where: { id: w } });
    }
  });

  it("idempotency keys cannot cross wallets", async () => {
    await creditTopUp(other, 100, `x:${other}`);
    await debitSpend(other, 10, { idempotencyKey: `shared:${other}` });
    await expect(debitSpend(biz, 10, { idempotencyKey: `shared:${other}` })).rejects.toMatchObject({ code: "conflict" });
  });

  it("invalid-click refund is idempotent and restores balance", async () => {
    const w = (await prisma.business.create({ data: { name: uniq + "-r" } })).id;
    try {
      await creditTopUp(w, 1000, `r:${w}`);
      await debitSpend(w, 400, { idempotencyKey: `rs:${w}` });
      const a = await refundInvalidClick(w, "click-1", 150);
      const b = await refundInvalidClick(w, "click-1", 150);
      expect(b).toMatchObject({ duplicate: true, entryId: a.entryId });
      expect(await getAdWalletBalance(w)).toBe(750);
    } finally {
      await prisma.adWalletEntry.deleteMany({ where: { businessId: w } });
      await prisma.business.delete({ where: { id: w } });
    }
  });

  it("promo credit expires, is spent first, is not refundable to source, and the expiry job is idempotent", async () => {
    const w = (await prisma.business.create({ data: { name: uniq + "-e" } })).id;
    try {
      await creditTopUp(w, 1000, `e:${w}`);
      const now = new Date();
      await grantAdPromoCredit(w, 300, { refType: "coupon", refId: `c-${w}` }, { now });
      expect((await grantAdPromoCredit(w, 300, { refType: "coupon", refId: `c-${w}` }, { now })).duplicate).toBe(true);
      expect(await grantAdPromoCredit(w, 100, { refType: "coupon", refId: `c2-${w}` }, { expiresAt: new Date(Date.now() + 60_000) })).toBeTruthy();
      await expect(grantAdPromoCredit(w, 100, { refType: "coupon", refId: "past" }, { expiresAt: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "validation" });
      const s = await getAdWalletState(w);
      expect(s).toMatchObject({ balancePaise: 1400, promoPaise: 400 });
      await expect(refundAdWalletToSource(w, 1100, `rf1-${w}`)).rejects.toMatchObject({ code: "insufficient_credits" });
      expect((await refundAdWalletToSource(w, 200, `rf2-${w}`)).duplicate).toBe(false);
      expect((await refundAdWalletToSource(w, 200, `rf2-${w}`)).duplicate).toBe(true);
      // spend 100: comes out of the soonest-expiring promo lot (c2), leaving 300 promo + 800-... paid
      await debitSpend(w, 100, { idempotencyKey: `sp-${w}` });
      const later = new Date(Date.now() + 100 * 86_400_000);
      const st = await getAdWalletState(w, later);
      expect(st.balancePaise).toBe(800); // paid 1000 - 200 refunded; both promo lots lapsed
      expect(st.lapsed.map((l) => l.remaining).sort()).toEqual([300]);
      expect(await expireLapsedAdPromo(later)).toBeGreaterThanOrEqual(0);
    } finally {
      await prisma.adWalletEntry.deleteMany({ where: { businessId: w } });
      await prisma.business.delete({ where: { id: w } });
    }
  });

  it("expiry job writes one row per lapsed lot and is safe to repeat", async () => {
    const w = (await prisma.business.create({ data: { name: uniq + "-x" } })).id;
    try {
      await prisma.adWalletEntry.create({ data: { businessId: w, deltaPaise: 700n, reason: "promo_credit", expiresAt: new Date(Date.now() - 86_400_000), idempotencyKey: `old:${w}` } });
      expect(await expireLapsedAdPromo()).toBeGreaterThanOrEqual(1);
      const rows = await prisma.adWalletEntry.findMany({ where: { businessId: w, reason: "promo_expire" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deltaPaise).toBe(-700n);
      await expireLapsedAdPromo();
      expect(await prisma.adWalletEntry.count({ where: { businessId: w, reason: "promo_expire" } })).toBe(1);
      expect(await getAdWalletBalance(w)).toBe(0);
    } finally {
      await prisma.adWalletEntry.deleteMany({ where: { businessId: w } });
      await prisma.business.delete({ where: { id: w } });
    }
  });

  it("adjustments are idempotent and cannot overdraw", async () => {
    const w = (await prisma.business.create({ data: { name: uniq + "-a" } })).id;
    try {
      await adjustAdWallet(w, 500, `a1-${w}`);
      expect((await adjustAdWallet(w, 500, `a1-${w}`)).duplicate).toBe(true);
      await expect(adjustAdWallet(w, -600, `a2-${w}`)).rejects.toMatchObject({ code: "insufficient_credits" });
      await adjustAdWallet(w, -200, `a3-${w}`);
      expect(await getAdWalletBalance(w)).toBe(300);
      await expect(adjustAdWallet(w, 0, "z")).rejects.toMatchObject({ code: "validation" });
      await expect(adjustAdWallet(w, 5, "")).rejects.toMatchObject({ code: "validation" });
      await expect(refundAdWalletToSource(w, 5, "")).rejects.toMatchObject({ code: "validation" });
      const ledger = await getAdWalletLedger(w);
      expect(ledger.map((l) => l.reason)).toEqual(["adjustment", "adjustment"]);
    } finally {
      await prisma.adWalletEntry.deleteMany({ where: { businessId: w } });
      await prisma.business.delete({ where: { id: w } });
    }
  });

  it("non-ad revenue sums paid non-ad orders in the window", async () => {
    const from = new Date(Date.now() - 1000);
    const mk = (purpose: string, amount: bigint, status: "paid" | "failed") =>
      prisma.paymentOrder.create({ data: { businessId: biz, purpose, provider: "mock", amountPaise: amount, gstPaise: 0n, totalPaise: amount, status } });
    const ids = [await mk("subscription", 1000n, "paid"), await mk("ad_topup", 5000n, "paid"), await mk("credit_pack", 700n, "failed")];
    try {
      const sum = await getNonAdRevenuePaise(from, new Date(Date.now() + 60_000));
      expect(sum).toBeGreaterThanOrEqual(1000);
      const before = sum;
      await prisma.paymentOrder.update({ where: { id: ids[2]!.id }, data: { status: "paid" } });
      expect(await getNonAdRevenuePaise(from, new Date(Date.now() + 60_000))).toBe(before + 700);
    } finally {
      await prisma.paymentOrder.deleteMany({ where: { id: { in: ids.map((i) => i.id) } } });
    }
  });
});
