"use client";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button } from "@cnote/ui";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { cancelPlanAction, subscribeAction, type BillingResult } from "./actions";

export function SubscribeButton({ planCode, label, current }: { planCode: string; label: string; current: boolean }) {
  const t = useTranslations("billing");
  const [state, action] = useActionState<BillingResult | null, FormData>(subscribeAction, null);
  if (current) return <p className="text-sm font-medium text-success">{t("yourCurrentPlan")}</p>;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="planCode" value={planCode} />
      <SubmitButton variant="outline-brand" className="w-full" pendingText={t("starting")}>{label}</SubmitButton>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("planStarted")}</Alert> : null}
    </form>
  );
}

/** ADR-005: cancel in at most 3 taps: "Cancel plan" (1) -> "Yes, cancel" (2). */
export function CancelPlan({ endsOn }: { endsOn: string }) {
  const t = useTranslations("billing");
  const [confirming, setConfirming] = useState(false);
  const [state, action] = useActionState<BillingResult | null, FormData>(cancelPlanAction, null);
  if (!confirming) return <Button variant="outline" className="min-h-11" onClick={() => setConfirming(true)}>{t("cancelPlan")}</Button>;
  return (
    <form action={action} className="space-y-3 rounded-lg border border-line bg-canvas p-4">
      <p className="text-sm text-ink">{t("cancelConfirmText", { date: endsOn })}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton variant="danger" pendingText={t("cancelling")}>{t("confirmCancel")}</SubmitButton>
        <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>{t("keepPlan")}</Button>
      </div>
      <FormAlert state={state} />
    </form>
  );
}
