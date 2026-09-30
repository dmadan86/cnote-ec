// Coupons for plans and credits (ADR-025 (3), design 6.3). billing never imports this module; the lead registers `couponPort`
// with billing's setCouponPort. Applies to the FIRST billing period only, one per checkout, never stackable, credits not cash.
//
// Abuse controls: rate-limited attempts (per business, optionally per IP), ONE generic "not valid" message for wrong/expired/
// exhausted/ineligible codes (no enumeration), random codes for generated coupons, one per business AND per GSTIN, redemption
// serialised by SELECT ... FOR UPDATE on the coupon row, idempotent on (coupon, business, checkoutRef), second approver for large values.
import { randomBytes } from "node:crypto";
import { getActiveSubscription, grantCredits } from "@cnote/billing";
import { DomainError, emit, rateLimit, redis } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { COUPON } from "./config";
import { riskKeys } from "./ports";

export type CouponKindName = "percent" | "flat" | "extra_credits" | "ad_credit";
export type CouponStatusName = "draft" | "active" | "paused" | "expired" | "exhausted";

const INVALID = "This code is not valid.";
const invalid = () => new DomainError("validation", INVALID);

export interface CouponInput {
  code?: string;
  name: string;
  kind: CouponKindName;
  percentBps?: number;
  maxDiscountPaise?: number;
  valuePaise?: number;
  extraCredits?: number;
  planCodes?: string[];
  firstPurchaseOnly?: boolean;
  minTier?: number;
  perBusinessLimit?: number;
  maxRedemptions?: number | null;
  validFrom: Date | string;
  validTo: Date | string;
}

export interface CouponView {
  id: string;
  code: string;
  name: string;
  kind: CouponKindName;
  status: CouponStatusName;
  percentBps: number | null;
  maxDiscountPaise: number | null;
  valuePaise: number | null;
  extraCredits: number | null;
  planCodes: string[];
  firstPurchaseOnly: boolean;
  minTier: number;
  perBusinessLimit: number;
  maxRedemptions: number | null;
  redeemedCount: number;
  validFrom: string;
  validTo: string;
  createdBy: string;
  approvedBy: string | null;
  requiresSecondApprover: boolean;
  createdAt: string;
}
type Row = NonNullable<Awaited<ReturnType<typeof prisma.coupon.findUnique>>>;
const num = (b: bigint | null) => (b === null ? null : Number(b));

export function requiresSecondApprover(c: { kind: CouponKindName; percentBps: number | null; valuePaise: number | null; extraCredits: number | null }): boolean {
  return c.kind === "ad_credit" || (c.percentBps ?? 0) > COUPON.largePercentBps || (c.valuePaise ?? 0) >= COUPON.largeFlatPaise || (c.extraCredits ?? 0) >= COUPON.largeExtraCredits;
}

const toView = (c: Row): CouponView => ({
  id: c.id, code: c.code, name: c.name, kind: c.kind, status: c.status, percentBps: c.percentBps, maxDiscountPaise: num(c.maxDiscountPaise), valuePaise: num(c.valuePaise),
  extraCredits: c.extraCredits, planCodes: c.planCodes, firstPurchaseOnly: c.firstPurchaseOnly, minTier: c.minTier, perBusinessLimit: c.perBusinessLimit, maxRedemptions: c.maxRedemptions,
  redeemedCount: c.redeemedCount, validFrom: c.validFrom.toISOString(), validTo: c.validTo.toISOString(), createdBy: c.createdBy, approvedBy: c.approvedBy,
  requiresSecondApprover: requiresSecondApprover({ kind: c.kind, percentBps: c.percentBps, valuePaise: num(c.valuePaise), extraCredits: c.extraCredits }), createdAt: c.createdAt.toISOString(),
});

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function randomCode(len = 12): string {
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}
export const normaliseCode = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,31}$/;

/** Creates a DRAFT coupon. `ad_credit` requires super_admin (the console passes `isSuperAdmin`). Generated codes are random 12 chars. */
export async function createCoupon(input: CouponInput, actor: { staffId: string; isSuperAdmin?: boolean }): Promise<CouponView> {
  const from = new Date(input.validFrom);
  const to = new Date(input.validTo);
  if (!(from < to)) throw new DomainError("validation", "Valid-to must be after valid-from", undefined, "promotions.validMustAfterValidFrom");
  if (!input.name.trim()) throw new DomainError("validation", "Name is required", undefined, "promotions.nameRequired");
  if (input.kind === "ad_credit" && !actor.isSuperAdmin) throw new DomainError("forbidden", "Ad-credit coupons can only be created by a super admin");
  const int = (v: number | undefined | null) => v !== undefined && v !== null && Number.isInteger(v) && v > 0;
  if (input.kind === "percent" && !(int(input.percentBps) && input.percentBps! <= 10_000)) throw new DomainError("validation", "Percent coupons need a percentage between 0.01% and 100%", undefined, "promotions.percentCouponsNeedPercentageBetween");
  if (input.kind === "flat" && !int(input.valuePaise)) throw new DomainError("validation", "Flat coupons need an amount", undefined, "promotions.flatCouponsNeedAmount");
  if (input.kind === "ad_credit" && !int(input.valuePaise)) throw new DomainError("validation", "Ad-credit coupons need an amount");
  if (input.kind === "extra_credits" && !int(input.extraCredits)) throw new DomainError("validation", "Credit coupons need a number of credits", undefined, "promotions.creditCouponsNeedNumberCredits");
  const code = input.code ? normaliseCode(input.code) : randomCode();
  if (!CODE_RE.test(code)) throw new DomainError("validation", "Codes use 4-32 letters, numbers or dashes", undefined, "promotions.codesUseLettersNumbersDashes");
  try {
    const c = await prisma.coupon.create({
      data: {
        code, name: input.name.trim().slice(0, 120), kind: input.kind, percentBps: input.kind === "percent" ? input.percentBps : null,
        maxDiscountPaise: input.maxDiscountPaise ? BigInt(input.maxDiscountPaise) : null,
        valuePaise: input.kind === "flat" || input.kind === "ad_credit" ? BigInt(input.valuePaise!) : null,
        extraCredits: input.kind === "extra_credits" ? input.extraCredits : null,
        planCodes: (input.planCodes ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean),
        firstPurchaseOnly: input.firstPurchaseOnly ?? true, minTier: input.minTier ?? 1, perBusinessLimit: input.perBusinessLimit ?? 1,
        maxRedemptions: input.maxRedemptions ?? null, validFrom: from, validTo: to, createdBy: actor.staffId,
      },
    });
    return toView(c);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new DomainError("conflict", "That code already exists", undefined, "promotions.codeAlreadyExists");
    throw e;
  }
}

async function requireCoupon(id: string): Promise<Row> {
  const c = /^[0-9a-f-]{36}$/i.test(id) ? await prisma.coupon.findUnique({ where: { id } }) : null;
  if (!c) throw new DomainError("not_found", "Coupon not found", undefined, "promotions.couponNotFound");
  return c;
}

export async function getCoupon(id: string): Promise<CouponView | null> {
  const c = /^[0-9a-f-]{36}$/i.test(id) ? await prisma.coupon.findUnique({ where: { id } }) : null;
  return c ? toView(c) : null;
}
export async function listCoupons(opts: { limit?: number } = {}): Promise<CouponView[]> {
  return (await prisma.coupon.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 200) })).map(toView);
}

/** Activation; large values (>50%, >= Rs 5,000, >= 200 credits, ad credit) need an approver different from the creator. */
export async function activateCoupon(id: string, staffId: string, opts: { isSuperAdmin?: boolean } = {}): Promise<CouponView> {
  const c = await requireCoupon(id);
  if (c.status !== "draft" && c.status !== "paused") throw new DomainError("conflict", "Only a draft or paused coupon can be activated", undefined, "promotions.onlyDraftPausedCouponActivated");
  if (c.validTo <= new Date()) throw new DomainError("validation", "This coupon's validity has already ended", undefined, "promotions.couponsValidityAlreadyEnded");
  const view = toView(c);
  if (c.kind === "ad_credit" && !opts.isSuperAdmin) throw new DomainError("forbidden", "Ad-credit coupons need a super admin");
  let approvedBy = c.approvedBy;
  if (view.requiresSecondApprover && c.status === "draft") {
    if (staffId === c.createdBy) throw new DomainError("forbidden", "A different staff member must approve a coupon of this value (two-person rule)");
    approvedBy = staffId;
  }
  return toView(await prisma.coupon.update({ where: { id }, data: { status: "active", approvedBy } }));
}

export async function pauseCoupon(id: string): Promise<CouponView> {
  const c = await requireCoupon(id);
  if (c.status !== "active") throw new DomainError("conflict", "Only an active coupon can be paused", undefined, "promotions.onlyActiveCouponPaused");
  return toView(await prisma.coupon.update({ where: { id }, data: { status: "paused" } }));
}

/** Job: flag coupons past validity as expired. */
export async function expireCoupons(now = new Date()): Promise<number> {
  return (await prisma.coupon.updateMany({ where: { status: { in: ["active", "paused"] }, validTo: { lte: now } }, data: { status: "expired" } })).count;
}

// ------------------------------------------------------------------------------------------------ quote / redeem

export interface CouponQuote {
  couponId: string;
  discountPaise: number;
  creditsBonus: number;
  /** plain-language terms for the checkout line (drip-pricing / subscription-trap guard) */
  terms: string;
}
export interface QuoteOptions {
  businessId: string;
  planCode?: string;
  amountPaise: number;
  /** optional: the caller's client IP for the second rate-limit bucket */
  ip?: string | null;
  /** optional: pass when the caller (billing/payments) knows whether this is the first paid purchase; otherwise inferred */
  isFirstPurchase?: boolean;
  /** optional: the checkout reference, so redeem can find the quote */
  paymentOrderId?: string;
}

export function computeDiscount(c: Pick<Row, "kind" | "percentBps" | "maxDiscountPaise" | "valuePaise" | "extraCredits">, amountPaise: number): { discountPaise: number; creditsBonus: number } {
  if (c.kind === "percent") {
    const raw = Math.floor((amountPaise * (c.percentBps ?? 0)) / 10_000);
    const cap = c.maxDiscountPaise === null ? raw : Number(c.maxDiscountPaise);
    return { discountPaise: Math.min(raw, cap, amountPaise), creditsBonus: 0 };
  }
  if (c.kind === "flat") return { discountPaise: Math.min(Number(c.valuePaise ?? 0), amountPaise), creditsBonus: 0 };
  if (c.kind === "extra_credits") return { discountPaise: 0, creditsBonus: c.extraCredits ?? 0 };
  return { discountPaise: 0, creditsBonus: 0 };
}

const snapKey = (couponId: string, businessId: string) => `coupon:quote:${couponId}:${businessId}`;

async function priorPaidPurchase(businessId: string): Promise<boolean> {
  // A paid coupon redemption (one that named a plan) is a prior purchase. Billing exposes no payment history yet, so an active paid plan counts too.
  const done = await prisma.couponRedemption.count({ where: { businessId, status: "applied", planCode: { not: null } } });
  if (done > 0) return true;
  const sub = await getActiveSubscription(businessId).catch(() => null);
  return !!sub && sub.planCode !== "free";
}

async function eligible(c: Row, o: { businessId: string; planCode?: string; amountPaise: number; isFirstPurchase?: boolean }, now: Date): Promise<void> {
  if (c.kind === "ad_credit") throw invalid(); // ad wallet credits are not redeemable at plan checkout
  if (c.status !== "active" || now < c.validFrom || now >= c.validTo) throw invalid();
  if (c.maxRedemptions !== null && c.redeemedCount >= c.maxRedemptions) throw invalid();
  if (!Number.isInteger(o.amountPaise) || o.amountPaise <= 0) throw new DomainError("validation", "A payable amount is required to apply a code", undefined, "promotions.payableAmountRequiredApplyCode");
  const plan = o.planCode?.toLowerCase();
  if (plan === "free") throw invalid();
  if (c.planCodes.length && (!plan || !c.planCodes.includes(plan))) throw invalid();
  if (c.firstPurchaseOnly && (o.isFirstPurchase === false || (o.isFirstPurchase === undefined && (await priorPaidPurchase(o.businessId))))) throw invalid();
  const keys = await riskKeys(o.businessId);
  if (keys.tier < c.minTier) throw new DomainError("forbidden", "Verify your business (GSTIN) to use this code.", undefined, "promotions.verifyBusinessGstinUseCode");
  const used = await prisma.couponRedemption.count({ where: { couponId: c.id, businessId: o.businessId, status: { not: "voided" } } });
  if (used >= c.perBusinessLimit) throw invalid();
  if (keys.gstin) {
    const sameGstin = await prisma.couponRedemption.count({ where: { couponId: c.id, gstin: keys.gstin, status: { not: "voided" } } });
    if (sameGstin >= c.perBusinessLimit) throw invalid();
  }
}

/**
 * Prices a code for a checkout. READ-ONLY (nothing is consumed until redeemCoupon). Returns the discount or throws DomainError:
 * "validation" with one generic message for any bad/ineligible code, "rate_limited" when attempts are exhausted.
 */
export async function quoteCoupon(code: string, opts: QuoteOptions): Promise<CouponQuote> {
  if (!(await rateLimit(`coupon:biz:${opts.businessId}`, COUPON.attemptsPerHour, 3600))) throw new DomainError("rate_limited", "Too many attempts. Please try again in an hour.", undefined, "domains.tooManyAttemptsTryAgain");
  if (opts.ip && !(await rateLimit(`coupon:ip:${opts.ip}`, COUPON.attemptsPerHour * 2, 3600))) throw new DomainError("rate_limited", "Too many attempts. Please try again in an hour.", undefined, "domains.tooManyAttemptsTryAgain");
  const norm = normaliseCode(code);
  if (!CODE_RE.test(norm)) throw invalid();
  const c = await prisma.coupon.findUnique({ where: { code: norm } });
  if (!c) throw invalid();
  await eligible(c, opts, new Date());
  const { discountPaise, creditsBonus } = computeDiscount(c, opts.amountPaise);
  if (discountPaise === 0 && creditsBonus === 0) throw invalid();
  await redis.set(snapKey(c.id, opts.businessId), JSON.stringify({ planCode: opts.planCode ?? null, amountPaise: opts.amountPaise }), "EX", COUPON.quoteSnapshotSeconds).catch(() => {});
  const terms = discountPaise > 0 ? "Applies to your first billing period only. Renewals are at the regular price and need your confirmation each month." : "Bonus lead credits are added after payment and expire after 90 days.";
  return { couponId: c.id, discountPaise, creditsBonus, terms };
}

export interface RedeemOptions {
  businessId: string;
  paymentOrderId: string;
  planCode?: string;
  amountPaise?: number;
}
export interface RedemptionResult {
  redemptionId: string;
  couponId: string;
  discountPaise: number;
  creditsGranted: number;
  /** true when this call was an idempotent retry of an already-applied redemption */
  replay: boolean;
}

/**
 * Consumes the coupon for a PAID checkout. Concurrency-safe: the coupon row is locked (FOR UPDATE), so N parallel redemptions
 * by one business can only succeed once and a capped coupon can never be over-redeemed. Idempotent on paymentOrderId.
 */
export async function redeemCoupon(couponId: string, opts: RedeemOptions, now = new Date()): Promise<RedemptionResult> {
  if (!opts.paymentOrderId?.trim()) throw new DomainError("validation", "A payment reference is required", undefined, "promotions.paymentReferenceRequired");
  const checkoutRef = opts.paymentOrderId.trim().slice(0, 120);
  const pre = await requireCoupon(couponId);
  let plan = opts.planCode;
  let amount = opts.amountPaise;
  if (amount === undefined) {
    const snap = await redis.get(snapKey(pre.id, opts.businessId)).catch(() => null);
    if (snap) {
      const s = JSON.parse(snap) as { planCode: string | null; amountPaise: number };
      amount = s.amountPaise;
      plan ??= s.planCode ?? undefined;
    }
  }
  const needsAmount = pre.kind === "percent" || pre.kind === "flat";
  if (amount === undefined && needsAmount) throw new DomainError("validation", "This code's quote has expired. Apply it again at checkout.", undefined, "promotions.codesQuoteExpiredApplyAgain");
  const keys = await riskKeys(opts.businessId);

  const res = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${pre.id}::uuid FOR UPDATE`;
    const c = await tx.coupon.findUniqueOrThrow({ where: { id: pre.id } });
    const same = await tx.couponRedemption.findUnique({ where: { couponId_businessId_checkoutRef: { couponId: c.id, businessId: opts.businessId, checkoutRef } } });
    if (same?.status === "applied") return { r: same, replay: true };
    if (same?.status === "voided") throw new DomainError("conflict", "This payment was already cancelled. Start a new checkout.", undefined, "promotions.paymentAlreadyCancelledStartNew");
    if (c.status !== "active" || now < c.validFrom || now >= c.validTo || c.kind === "ad_credit") throw invalid();
    if (c.maxRedemptions !== null && c.redeemedCount >= c.maxRedemptions) {
      if (c.status === "active") await tx.coupon.update({ where: { id: c.id }, data: { status: "exhausted" } });
      throw invalid();
    }
    const others = await tx.couponRedemption.count({ where: { couponId: c.id, businessId: opts.businessId, status: { not: "voided" }, ...(same ? { id: { not: same.id } } : {}) } });
    if (others >= c.perBusinessLimit) throw invalid();
    if (keys.gstin) {
      const byGstin = await tx.couponRedemption.count({ where: { couponId: c.id, gstin: keys.gstin, status: { not: "voided" }, ...(same ? { id: { not: same.id } } : {}) } });
      if (byGstin >= c.perBusinessLimit) throw invalid();
    }
    const { discountPaise, creditsBonus } = computeDiscount(c, amount ?? 0);
    const r = same
      ? await tx.couponRedemption.update({ where: { id: same.id }, data: { status: "applied", appliedAt: now, discountPaise: BigInt(discountPaise), creditsGranted: creditsBonus } })
      : await tx.couponRedemption.create({
          data: { couponId: c.id, businessId: opts.businessId, gstin: keys.gstin, planCode: plan ?? null, discountPaise: BigInt(discountPaise), creditsGranted: creditsBonus, status: "applied", checkoutRef, appliedAt: now },
        });
    const count = c.redeemedCount + 1;
    await tx.coupon.update({ where: { id: c.id }, data: { redeemedCount: count, ...(c.maxRedemptions !== null && count >= c.maxRedemptions ? { status: "exhausted" as const } : {}) } });
    await emit(tx, "CouponRedeemed", { type: "coupon", id: c.id }, { couponId: c.id, redemptionId: r.id, businessId: opts.businessId, planCode: plan ?? null, discountPaise, creditsGranted: creditsBonus });
    return { r, replay: false };
  }, { timeout: 20_000 });

  const credits = res.r.creditsGranted;
  // idempotent per redemption id, so a retried redeem (or the replay path) can never double-grant
  if (credits > 0) await grantCredits(opts.businessId, credits, "coupon", { refType: "coupon", refId: res.r.id });
  await redis.del(snapKey(pre.id, opts.businessId)).catch(() => {});
  return { redemptionId: res.r.id, couponId: pre.id, discountPaise: Number(res.r.discountPaise), creditsGranted: credits, replay: res.replay };
}

/** Voids a redemption whose payment failed or was abandoned (frees the slot). Redemptions that granted credits cannot be voided. */
export async function voidRedemption(redemptionId: string, reason: string): Promise<void> {
  const r = /^[0-9a-f-]{36}$/i.test(redemptionId) ? await prisma.couponRedemption.findUnique({ where: { id: redemptionId } }) : null;
  if (!r) throw new DomainError("not_found", "Redemption not found", undefined, "promotions.redemptionNotFound");
  if (r.status === "voided") return;
  if (r.creditsGranted > 0) throw new DomainError("conflict", "Credits from this coupon were already granted and cannot be reversed.", undefined, "promotions.creditsFromCouponAlreadyGranted");
  await prisma.$transaction(async (tx: Tx) => {
    await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${r.couponId}::uuid FOR UPDATE`;
    const n = await tx.couponRedemption.updateMany({ where: { id: r.id, status: { not: "voided" } }, data: { status: "voided" } });
    if (n.count === 0) return;
    if (r.status === "applied") {
      await tx.coupon.update({ where: { id: r.couponId }, data: { redeemedCount: { decrement: 1 } } });
      await tx.coupon.updateMany({ where: { id: r.couponId, status: "exhausted", validTo: { gt: new Date() } }, data: { status: "active" } });
    }
    await emit(tx, "CouponVoided", { type: "coupon", id: r.couponId }, { couponId: r.couponId, redemptionId: r.id, businessId: r.businessId, reason: reason.slice(0, 200) });
  });
}

export async function listRedemptions(couponId: string, limit = 100) {
  const rows = await prisma.couponRedemption.findMany({ where: { couponId }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 500) });
  return rows.map((r) => ({ id: r.id, businessId: r.businessId, planCode: r.planCode, discountPaise: Number(r.discountPaise), creditsGranted: r.creditsGranted, status: r.status, checkoutRef: r.checkoutRef, createdAt: r.createdAt.toISOString() }));
}

/** Register with billing: `setCouponPort(couponPort)`. */
export const couponPort = { quoteCoupon, redeemCoupon };
