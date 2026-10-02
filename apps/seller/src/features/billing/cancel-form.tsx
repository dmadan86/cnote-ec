"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Field, Select } from "@cnote/ui";
import { CANCEL_REASONS } from "@cnote/billing/pricing";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { cancelPlanAction, type BillingResult } from "./actions";

/**
 * ADR-005: the last step of "cancel in 3 taps". One optional select, one confirm button, one way back. No retention
 * offer, no extra confirmation, nothing pre-selected.
 */
export function CancelForm() {
  const t = useTranslations("billingAnnual.cancel");
  const [state, action] = useActionState<BillingResult | null, FormData>(cancelPlanAction, null);
  return (
    <form action={action} className="space-y-4">
      <Field label={t("reasonLabel")} htmlFor="cancel-reason">
        <Select id="cancel-reason" name="reason" defaultValue="" className="min-h-11">
          <option value="">{t("reasonNone")}</option>
          {CANCEL_REASONS.map((r) => <option key={r} value={r}>{t(`reason.${r}`)}</option>)}
        </Select>
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton variant="danger" pendingText={t("cancelling")}>{t("confirm")}</SubmitButton>
        <Link href="/billing" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-ink">{t("keep")}</Link>
      </div>
      <FormAlert state={state} />
    </form>
  );
}
