"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { SubmitButton, FormAlert } from "@/features/shell/form-bits";
import { checkoutAction, mockPayAction, type BillingResult } from "./actions";

export function ConfirmPayForm({ planCode, packId, couponCode }: { planCode?: string; packId?: string; couponCode?: string }) {
  const t = useTranslations("billing.checkout");
  const [state, action] = useActionState<BillingResult | null, FormData>(checkoutAction, null);
  return (
    <form action={action} className="space-y-2">
      {planCode ? <input type="hidden" name="planCode" value={planCode} /> : null}
      {packId ? <input type="hidden" name="packId" value={packId} /> : null}
      {couponCode ? <input type="hidden" name="couponCode" value={couponCode} /> : null}
      <SubmitButton className="w-full" pendingText={t("opening")}>{t("continue")}</SubmitButton>
      <FormAlert state={state} />
    </form>
  );
}

export function MockPayForm({ orderId }: { orderId: string }) {
  const t = useTranslations("billing.mockPay");
  const [state, action] = useActionState<BillingResult | null, FormData>(mockPayAction, null);
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row">
      <input type="hidden" name="orderId" value={orderId} />
      <button name="outcome" value="paid" type="submit" className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white">{t("paySimulated")}</button>
      <button name="outcome" value="failed" type="submit" className="min-h-11 rounded-lg border border-line px-4 text-sm">{t("failPayment")}</button>
      <FormAlert state={state} />
    </form>
  );
}

/** Polls the server component while the payment is still pending (the webhook can trail the redirect). */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
