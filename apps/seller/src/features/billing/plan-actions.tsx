"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "@cnote/ui";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { subscribeAction, type BillingResult } from "./actions";

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
