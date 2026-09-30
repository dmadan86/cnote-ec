"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Field, Input } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { savePriceBookAction, type NegotiationResult } from "./actions";

export interface PriceBookRow {
  listingId: string;
  title: string;
  unit: string;
  baseRupees: number;
  floorRupees: number;
  tiers: { minQty: number; rupees: number }[];
  moq: number | null;
  leadTimeDays: number;
  deliveryTerms: string | null;
  gstPercent: number | null;
  gstIncluded: boolean;
  validityDays: number;
  active: boolean;
  seeded: boolean;
}

export function PriceBookForm({ row }: { row: PriceBookRow }) {
  const t = useTranslations("negotiation.form");
  const [state, action] = useActionState<NegotiationResult | null, FormData>(savePriceBookAction, null);
  const id = (k: string) => `pb-${row.listingId}-${k}`;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="listingId" value={row.listingId} />
      <input type="hidden" name="unit" value={row.unit} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("basePrice", { unit: row.unit })} htmlFor={id("base")} error={fieldError(state, "base")}>
          <Input id={id("base")} name="base" inputMode="decimal" required defaultValue={row.baseRupees} className="h-11" />
        </Field>
        <Field label={t("floor")} htmlFor={id("floor")} hint={t("floorHint")} error={fieldError(state, "floor")}>
          <Input id={id("floor")} name="floor" inputMode="decimal" required defaultValue={row.floorRupees} className="h-11" />
        </Field>
        <Field label={t("moq")} htmlFor={id("moq")} error={fieldError(state, "moq")}>
          <Input id={id("moq")} name="moq" inputMode="numeric" defaultValue={row.moq ?? ""} className="h-11" />
        </Field>
        <Field label={t("lead")} htmlFor={id("lead")} error={fieldError(state, "leadTimeDays")}>
          <Input id={id("lead")} name="leadTimeDays" inputMode="numeric" required defaultValue={row.leadTimeDays} className="h-11" />
        </Field>
        <Field label={t("valid")} htmlFor={id("valid")} error={fieldError(state, "validityDays")}>
          <Input id={id("valid")} name="validityDays" inputMode="numeric" required defaultValue={row.validityDays} className="h-11" />
        </Field>
        <Field label={t("gst")} htmlFor={id("gst")} error={fieldError(state, "gstPercent")}>
          <Input id={id("gst")} name="gstPercent" inputMode="numeric" defaultValue={row.gstPercent ?? ""} className="h-11" />
        </Field>
      </div>
      <Field label={t("terms")} htmlFor={id("terms")} hint={t("termsHint")} error={fieldError(state, "deliveryTerms")}>
        <Input id={id("terms")} name="deliveryTerms" maxLength={300} defaultValue={row.deliveryTerms ?? ""} className="h-11" />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">{t("tiersLegend")}</legend>
        <p id={id("tiers-hint")} className="text-xs text-muted">{t("tiersHint")}</p>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid grid-cols-2 gap-3">
            <Field label={t("breakQty", { n: i + 1 })} htmlFor={id(`tq${i}`)} error={i === 0 ? fieldError(state, "tierQty0") : fieldError(state, `tierQty${i}`)}>
              <Input id={id(`tq${i}`)} name={`tierQty${i}`} inputMode="numeric" defaultValue={row.tiers[i]?.minQty ?? ""} aria-describedby={id("tiers-hint")} className="h-11" />
            </Field>
            <Field label={t("breakPrice", { n: i + 1, unit: row.unit })} htmlFor={id(`tp${i}`)}>
              <Input id={id(`tp${i}`)} name={`tierPrice${i}`} inputMode="decimal" defaultValue={row.tiers[i]?.rupees ?? ""} className="h-11" />
            </Field>
          </div>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="gstIncluded" defaultChecked={row.gstIncluded} className="size-4 accent-brand-600" /> {t("gstIncluded")}</label>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="active" defaultChecked={row.active} className="size-4 accent-brand-600" /> {t("active")}</label>
      </div>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
      <SubmitButton pendingText={t("saving")}>{t("save")}</SubmitButton>
    </form>
  );
}
