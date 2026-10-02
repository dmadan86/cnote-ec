"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { billing } from "@/lib/services";

export type BillingResult = ActionResult<null>;

function refresh() {
  revalidatePath("/billing");
  revalidatePath("/dashboard");
  revalidatePath("/leads");
}

function actor(session: Awaited<ReturnType<typeof requireSeller>>) {
  return { businessId: session.business.id, name: session.name ?? undefined, email: session.email ?? undefined, phone: session.phone ?? undefined };
}

/**
 * ADR-005: explicit, user-initiated plan start. Never auto-upgraded. The free plan switches immediately; paid plans
 * continue to the order summary (/billing/checkout) and are activated by the payment webhook.
 */
export async function subscribeAction(_prev: BillingResult | null, fd: FormData): Promise<BillingResult> {
  const session = await requireSeller("/billing");
  const t = await getTranslations("billing.errors");
  const res = await run(async () => {
    const code = z.string().min(1, t("choosePlan")).parse(str(fd, "planCode"));
    const plan = (await billing.listPlans()).find((p) => p.code === code);
    if (!plan) throw new z.ZodError([{ code: "custom", path: ["planCode"], message: t("planNotShown"), input: code }]);
    if (plan.monthlyPricePaise > 0) return `/billing/checkout?plan=${encodeURIComponent(code)}`;
    await billing.subscribe(session.business.id, code);
    logEvent("seller.plan_started", { businessId: session.business.id, planCode: code });
    refresh();
    return null;
  });
  if (res.ok && res.data) redirect(res.data);
  return res.ok ? { ok: true, data: null } : res;
}

/** Order summary confirmed: create the PaymentOrder and hand over to the gateway's hosted page (no card data here, ADR-010). */
export async function checkoutAction(_prev: BillingResult | null, fd: FormData): Promise<BillingResult> {
  const session = await requireSeller("/billing");
  const t = await getTranslations("billing.errors");
  const res = await run(async () => {
    const couponCode = str(fd, "couponCode") || undefined;
    const planCode = str(fd, "planCode");
    const packId = str(fd, "packId");
    const interval = str(fd, "interval") === "annual" ? "annual" : "monthly";
    const c = await billing.startCheckout(
      actor(session),
      planCode ? { purpose: "subscription", planCode, couponCode, interval } : { purpose: "credit_pack", packId: z.string().min(1, t("choosePack")).parse(packId), couponCode },
    );
    logEvent("seller.checkout_started", { businessId: session.business.id, purpose: planCode ? "subscription" : "credit_pack", ref: planCode || packId });
    return c.redirectUrl;
  });
  if (res.ok) redirect(res.data);
  return res;
}

/** Dev only (PAYMENTS_PROVIDER=mock): the local "pay" page outcome. */
export async function mockPayAction(_prev: BillingResult | null, fd: FormData): Promise<BillingResult> {
  const session = await requireSeller("/billing");
  const orderId = str(fd, "orderId");
  const outcome = str(fd, "outcome") === "failed" ? "failed" : "paid";
  const res = await run(async () => {
    await billing.completeMockPayment({ businessId: session.business.id }, orderId, outcome);
    refresh();
    return null;
  });
  if (res.ok) redirect(`/billing/return?order=${encodeURIComponent(orderId)}`);
  return res;
}

/**
 * ADR-005: cancel in 3 taps. Billing -> "Cancel plan" (1) -> "Yes, cancel my plan" (2) -> back on Billing with the
 * result. The reason is optional and there is no retention step.
 */
export async function cancelPlanAction(_prev: BillingResult | null, fd: FormData): Promise<BillingResult> {
  const session = await requireSeller("/billing");
  const reason = str(fd, "reason") || undefined;
  const res = await run(async () => {
    const q = await billing.cancelSubscriptionWithQuote(session.business.id, { reason });
    logEvent("seller.plan_cancelled", { businessId: session.business.id, refundPaise: q.refundPaise });
    refresh();
    return q.refundPaise;
  });
  if (res.ok) redirect(`/billing?cancelled=1&refund=${res.data}`);
  return res;
}
