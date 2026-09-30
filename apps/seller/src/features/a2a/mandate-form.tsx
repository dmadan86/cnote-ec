"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Field, Input, Select } from "@cnote/ui";
import type { MandateView } from "@cnote/a2a";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { createMandateAction, updateMandateAction, type AgentResult } from "./actions";
import { paiseToRupeeText } from "./money";

export interface PriceBookOption { id: string; title: string }

/** Create (mode "create": explicit opt-in, auto-accept stays off) or edit a quoting mandate. Money is typed in rupees, sent as text and converted to integer paise on the server. */
export function MandateForm({ mode, priceBook, mandate, expiryDate }: { mode: "create" | "edit"; priceBook: PriceBookOption[]; mandate?: MandateView; expiryDate?: string }) {
  const t = useTranslations("a2a");
  const [state, action] = useActionState<AgentResult | null, FormData>(mode === "create" ? createMandateAction : updateMandateAction, null);
  const p = mode === "edit" ? "e" : "c";
  const id = (k: string) => `mf-${p}-${k}`;
  return (
    <form action={action} className="space-y-4">
      {mandate ? <input type="hidden" name="id" value={mandate.id} /> : null}
      {mandate ? <input type="hidden" name="expiresAtInitial" value={expiryDate ?? ""} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("form.name")} htmlFor={id("name")} error={fieldError(state, "name")}>
          <Input id={id("name")} name="name" required minLength={3} maxLength={80} defaultValue={mandate?.name ?? ""} className="h-11" />
        </Field>
        <Field label={t("form.priceBook")} htmlFor={id("pb")} hint={t("form.priceBookHint")} error={fieldError(state, "priceBookId")}>
          <Select id={id("pb")} name="priceBookId" defaultValue={mandate?.priceBookId ?? ""} className="h-11">
            <option value="">{t("form.priceBookAny")}</option>
            {priceBook.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </Select>
        </Field>
        <Field label={t("form.floor")} htmlFor={id("floor")} hint={t("form.floorHint")} error={fieldError(state, "floor")}>
          <Input id={id("floor")} name="floor" inputMode="decimal" defaultValue={paiseToRupeeText(mandate?.limitPricePaise)} className="h-11" />
        </Field>
        <Field label={t("form.maxDiscount")} htmlFor={id("disc")} hint={t("form.maxDiscountHint")} error={fieldError(state, "maxDiscountPct")}>
          <Input id={id("disc")} name="maxDiscountPct" inputMode="numeric" defaultValue={mandate?.maxDiscountPct ?? ""} className="h-11" />
        </Field>
        <Field label={t("form.capacity")} htmlFor={id("cap")} hint={t("form.capacityHint")} error={fieldError(state, "capacityQty")}>
          <Input id={id("cap")} name="capacityQty" inputMode="numeric" defaultValue={mandate?.capacityQty ?? ""} className="h-11" />
        </Field>
        <Field label={t("form.rounds")} htmlFor={id("rounds")} hint={t("form.roundsHint")} error={fieldError(state, "maxRounds")}>
          <Input id={id("rounds")} name="maxRounds" inputMode="numeric" defaultValue={mandate?.maxRounds ?? 6} className="h-11" />
        </Field>
        <Field label={t("form.expires")} htmlFor={id("exp")} hint={t("form.expiresHint")} error={fieldError(state, "expiresAt")}>
          <Input id={id("exp")} name="expiresAt" type="date" defaultValue={expiryDate ?? ""} className="h-11" />
        </Field>
        <Field label={t("form.delivery")} htmlFor={id("del")} error={fieldError(state, "deliveryTerms")}>
          <Input id={id("del")} name="deliveryTerms" maxLength={300} defaultValue={mandate?.deliveryTerms ?? ""} className="h-11" />
        </Field>
        <Field label={t("form.payment")} htmlFor={id("pay")} error={fieldError(state, "paymentTerms")}>
          <Input id={id("pay")} name="paymentTerms" maxLength={200} defaultValue={mandate?.paymentTerms ?? ""} className="h-11" />
        </Field>
      </div>
      {mode === "create" ? (
        <div>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input type="checkbox" name="optIn" required className="mt-1 size-4 accent-brand-600" aria-describedby={fieldError(state, "optIn") ? id("optin-err") : undefined} />
            <span>{t("form.optIn")}</span>
          </label>
          {fieldError(state, "optIn") ? <p id={id("optin-err")} role="alert" className="text-xs text-danger">{fieldError(state, "optIn")}</p> : null}
          <p className="text-xs text-muted">{t("form.autoStartsOff")}</p>
        </div>
      ) : null}
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("form.saved")}</Alert> : null}
      <SubmitButton pendingText={t("form.saving")}>{mode === "create" ? t("form.create") : t("form.save")}</SubmitButton>
    </form>
  );
}
