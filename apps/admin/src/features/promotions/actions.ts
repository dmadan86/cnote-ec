"use server";
import { audited } from "@cnote/admin";
import { type ActionResult, runAction } from "@cnote/next-kit";
import {
  activateCoupon, approvePromotion, archivePromotion, createCoupon, createPromotion, decideHonourReport, pauseCoupon, rejectReferral, releaseReferral, returnPromotionToDraft,
  reviewOffer, submitPromotion, suspendOffer, updatePromotion, voidRedemption, CONTENT_LOCALES, type CouponInput, type PromotionInput,
} from "@cnote/promotions";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

// Every mutation: staff session (actionContext) -> audited() checks the privilege, runs, and appends to AdminAuditLog.
// promotions.manage = author (draft/edit/submit) · promotions.publish = approve/return/archive (a DIFFERENT person than the author,
// enforced in the module, not just by privilege) · offers.review · coupons.manage · referrals.review.
const id = z.uuid();
const s = (fd: FormData, k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string).trim() : "");
const opt = (v: string) => (v === "" ? undefined : v);
/** datetime-local, India wall clock (+05:30, no DST). */
const ist = (v: string) => new Date(`${v}:00+05:30`);

function parseItems(text: string): PromotionInput["items"] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const [target, ...note] = line.split("|");
    const [type, value] = (target ?? "").trim().split(":");
    const key = type === "listing" ? "listingId" : type === "category" ? "categoryId" : type === "business" ? "businessId" : null;
    if (!key || !value) throw new z.ZodError([{ code: "custom", path: ["items"], message: `Bad pick "${line}". Use listing:<id> | reason, category:<id> | reason or business:<id> | reason.`, input: line }]);
    return { [key]: value.trim(), editorNote: note.join("|").trim() };
  }) as PromotionInput["items"];
}

function promotionInput(fd: FormData): PromotionInput {
  const contents = CONTENT_LOCALES.flatMap((l) => {
    const headline = s(fd, `${l}.headline`);
    if (!headline) return [];
    return [{ locale: l, headline, subline: opt(s(fd, `${l}.subline`)), ctaLabel: opt(s(fd, `${l}.ctaLabel`)), ctaHref: opt(s(fd, `${l}.ctaHref`)), imageKey: opt(s(fd, `${l}.imageKey`)), altText: opt(s(fd, `${l}.altText`)) }];
  });
  const states = s(fd, "states").split(",").map((x) => x.trim()).filter(Boolean);
  const languages = fd.getAll("languages").filter((x): x is string => typeof x === "string");
  return {
    kind: s(fd, "kind") as PromotionInput["kind"], template: s(fd, "template"), internalName: s(fd, "internalName"),
    surfaces: fd.getAll("surfaces") as PromotionInput["surfaces"], priority: Number(s(fd, "priority") || 0),
    startsAt: ist(s(fd, "startsAt")), endsAt: ist(s(fd, "endsAt")),
    audience: { segment: (s(fd, "segment") || "all") as "all", ...(states.length ? { states } : {}), ...(languages.length ? { languages: languages as never } : {}) },
    contents, items: parseItems(s(fd, "items")),
  };
}

export async function savePromotionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target: string | null = null;
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const existing = s(fd, "id");
    const input = promotionInput(fd);
    const p = existing
      ? await audited(ctx, "promotions.manage", "promotion.update", { type: "promotion", id: existing }, () => updatePromotion(id.parse(existing), input, ctx.staff.id), { name: input.internalName })
      : await audited(ctx, "promotions.manage", "promotion.create", { type: "promotion", id: null }, () => createPromotion(input, ctx.staff.id), { name: input.internalName });
    target = `/promotions/${p.id}`;
    revalidatePath("/promotions");
  });
  if (res.ok && target) redirect(target);
  return res;
}

export async function submitPromotionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const pid = id.parse(s(fd, "id"));
    await audited(ctx, "promotions.manage", "promotion.submit", { type: "promotion", id: pid }, () => submitPromotion(pid, ctx.staff.id));
  });
  if (res.ok) revalidatePath("/promotions", "layout");
  return res;
}

export async function approvePromotionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const pid = id.parse(s(fd, "id"));
    await audited(ctx, "promotions.publish", "promotion.approve", { type: "promotion", id: pid }, () => approvePromotion(pid, ctx.staff.id));
  });
  if (res.ok) revalidatePath("/promotions", "layout");
  return res;
}

export async function returnPromotionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const pid = id.parse(s(fd, "id"));
    await audited(ctx, "promotions.publish", "promotion.return_to_draft", { type: "promotion", id: pid }, () => returnPromotionToDraft(pid, ctx.staff.id), { note: s(fd, "note").slice(0, 300) });
  });
  if (res.ok) revalidatePath("/promotions", "layout");
  return res;
}

export async function archivePromotionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const pid = id.parse(s(fd, "id"));
    const reason = s(fd, "reason");
    await audited(ctx, "promotions.publish", "promotion.archive", { type: "promotion", id: pid }, () => archivePromotion(pid, ctx.staff.id, reason), { reason: reason.slice(0, 300) });
  });
  if (res.ok) revalidatePath("/promotions", "layout");
  return res;
}

// ---------------------------------------------------------------- offers
export async function reviewOfferAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const oid = id.parse(s(fd, "id"));
    const decision = z.enum(["approve", "reject"]).parse(s(fd, "decision"));
    await audited(ctx, "offers.review", `offer.${decision}`, { type: "offer", id: oid }, () => reviewOffer(oid, decision, ctx.staff.id, s(fd, "note")), { note: s(fd, "note").slice(0, 300) });
  });
  if (res.ok) revalidatePath("/offers");
  return res;
}

export async function suspendOfferAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const oid = id.parse(s(fd, "id"));
    await audited(ctx, "offers.review", "offer.suspend", { type: "offer", id: oid }, () => suspendOffer(oid, ctx.staff.id, s(fd, "note")), { note: s(fd, "note").slice(0, 300) });
  });
  if (res.ok) revalidatePath("/offers");
  return res;
}

export async function decideHonourAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const rid = id.parse(s(fd, "id"));
    const upheld = z.enum(["upheld", "dismissed"]).parse(s(fd, "decision")) === "upheld";
    await audited(ctx, "offers.review", `offer.honour_report.${upheld ? "uphold" : "dismiss"}`, { type: "offer_honour_report", id: rid }, () => decideHonourReport(rid, { upheld, decidedBy: ctx.staff.id }));
  });
  if (res.ok) revalidatePath("/offers");
  return res;
}

// ---------------------------------------------------------------- coupons
export async function createCouponAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const num = (k: string) => (s(fd, k) === "" ? undefined : Number(s(fd, k)));
    const rupees = (k: string) => (s(fd, k) === "" ? undefined : Math.round(Number(s(fd, k)) * 100));
    const kind = z.enum(["percent", "flat", "extra_credits", "ad_credit"]).parse(s(fd, "kind"));
    const input: CouponInput = {
      code: opt(s(fd, "code")), name: s(fd, "name"), kind, percentBps: num("percent") === undefined ? undefined : Math.round(num("percent")! * 100),
      maxDiscountPaise: rupees("maxDiscount"), valuePaise: rupees("value"), extraCredits: num("extraCredits"),
      planCodes: s(fd, "planCodes").split(",").map((x) => x.trim()).filter(Boolean), firstPurchaseOnly: fd.get("firstPurchaseOnly") === "on",
      minTier: num("minTier") ?? 1, perBusinessLimit: num("perBusinessLimit") ?? 1, maxRedemptions: num("maxRedemptions") ?? null,
      validFrom: ist(s(fd, "validFrom")), validTo: ist(s(fd, "validTo")),
    };
    const isSuperAdmin = ctx.staff.roles.includes("super_admin");
    await audited(ctx, "coupons.manage", "coupon.create", { type: "coupon", id: null }, () => createCoupon(input, { staffId: ctx.staff.id, isSuperAdmin }), { name: input.name, kind });
  });
  if (res.ok) revalidatePath("/coupons");
  return res;
}

export async function activateCouponAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const cid = id.parse(s(fd, "id"));
    await audited(ctx, "coupons.manage", "coupon.activate", { type: "coupon", id: cid }, () => activateCoupon(cid, ctx.staff.id, { isSuperAdmin: ctx.staff.roles.includes("super_admin") }));
  });
  if (res.ok) revalidatePath("/coupons");
  return res;
}

export async function pauseCouponAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const cid = id.parse(s(fd, "id"));
    await audited(ctx, "coupons.manage", "coupon.pause", { type: "coupon", id: cid }, () => pauseCoupon(cid));
  });
  if (res.ok) revalidatePath("/coupons");
  return res;
}

export async function voidRedemptionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const rid = id.parse(s(fd, "id"));
    await audited(ctx, "coupons.manage", "coupon.void_redemption", { type: "coupon_redemption", id: rid }, () => voidRedemption(rid, s(fd, "reason") || "staff void"));
  });
  if (res.ok) revalidatePath("/coupons");
  return res;
}

// ---------------------------------------------------------------- referrals
export async function releaseReferralAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const rid = id.parse(s(fd, "id"));
    await audited(ctx, "referrals.review", "referral.release", { type: "referral", id: rid }, () => releaseReferral(rid, { force: true }));
  });
  if (res.ok) revalidatePath("/referrals");
  return res;
}

export async function rejectReferralAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction(async () => {
    const ctx = await actionContext();
    const rid = id.parse(s(fd, "id"));
    const reason = s(fd, "reason");
    await audited(ctx, "referrals.review", "referral.reject", { type: "referral", id: rid }, () => rejectReferral(rid, reason, ctx.staff.id), { reason: reason.slice(0, 300) });
  });
  if (res.ok) revalidatePath("/referrals");
  return res;
}
