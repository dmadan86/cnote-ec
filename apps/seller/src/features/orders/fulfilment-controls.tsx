"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Field, Input, Textarea } from "@cnote/ui";
import type { FulfilmentStage } from "@cnote/enquiry";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { fulfilmentAction, type OrderResult } from "./actions";

/** Seller controls: pick the next step (radio group, keyboard operable), optional note and tracking details. */
export function FulfilmentControls({ orderId, stages }: { orderId: string; stages: FulfilmentStage[] }) {
  const t = useTranslations("orders.fulfilment");
  const [state, action] = useActionState<OrderResult | null, FormData>(fulfilmentAction, null);
  if (stages.length === 0) return null;
  return (
    <form action={action} className="space-y-4" aria-labelledby="fulfilment-record">
      <h3 id="fulfilment-record" className="text-sm font-semibold text-ink">{t("recordHeading")}</h3>
      <input type="hidden" name="orderId" value={orderId} />
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-ink">{t("stageLabel")}</legend>
        {stages.map((s, i) => (
          <label key={s} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input type="radio" name="stage" value={s} defaultChecked={i === 0} required className="size-5 accent-brand-600" />
            {t(`stage.${s}`)}
          </label>
        ))}
      </fieldset>
      <Field label={t("note")} htmlFor="ful-note"><Textarea id="ful-note" name="note" maxLength={500} rows={2} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("courier")} htmlFor="ful-courier"><Input id="ful-courier" name="courier" maxLength={80} autoComplete="off" /></Field>
        <Field label={t("awb")} htmlFor="ful-awb"><Input id="ful-awb" name="trackingRef" maxLength={80} autoComplete="off" /></Field>
      </div>
      <div aria-live="polite">
        <FormAlert state={state} />
        {state?.ok ? <p role="status" className="text-sm text-success">{t("saved")}</p> : null}
      </div>
      <SubmitButton pendingText={t("saving")}>{t("save")}</SubmitButton>
    </form>
  );
}
