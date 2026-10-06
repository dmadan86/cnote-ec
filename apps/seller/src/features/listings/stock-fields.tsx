"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Field, Input, Select } from "@cnote/ui";
import type { Availability, ListingView } from "@cnote/catalogue";
import { fieldError } from "@/features/shell/form-bits";
import type { SaveResult } from "./actions";
import { AVAILABILITY_OPTIONS } from "./stock-form";

/**
 * Availability inside the listing form. Field names: `availability`, `availableQty` (the lead time is the Trade details field
 * `leadTimeDays`). With variants the listing's state is derived from them, so the inputs give way to an explanation.
 */
export function AvailabilityFields({ listing, state }: { listing: ListingView | null; state: SaveResult | null }) {
  const t = useTranslations("stock");
  const hasVariants = (listing?.variants?.length ?? 0) > 0;
  const [value, setValue] = useState<Availability>(listing?.ownAvailability ?? "in_stock");
  if (hasVariants) {
    return (
      <fieldset className="space-y-2 rounded-card border border-line bg-surface p-4">
        <legend className="px-1 text-sm font-semibold text-ink">{t("section.legend")}</legend>
        <p className="text-sm text-ink" data-testid="rollup">{t("section.rollup", { state: t(`availability.${listing?.availability ?? "in_stock"}`) })}</p>
        <p className="text-xs text-muted">{t("section.instant")}</p>
      </fieldset>
    );
  }
  const err = fieldError(state, "availability");
  return (
    <fieldset className="space-y-4 rounded-card border border-line bg-surface p-4">
      <legend className="px-1 text-sm font-semibold text-ink">{t("section.legend")}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("section.status")} htmlFor="availability" error={err}>
          <Select id="availability" name="availability" value={value} onChange={(e) => setValue(e.target.value as Availability)} className="h-11">
            {AVAILABILITY_OPTIONS.map((a) => <option key={a} value={a}>{t(`availability.${a}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("section.qty")} htmlFor="availableQty" hint={t("section.qtyHint")} error={fieldError(state, "availableQty")}>
          <Input id="availableQty" name="availableQty" inputMode="numeric" disabled={value === "out_of_stock"} defaultValue={listing?.availableQty ?? ""} className="h-11" />
        </Field>
      </div>
      {value === "made_to_order" ? <p className="text-xs text-muted">{t("section.leadTimeNote")}</p> : null}
      <p className="text-xs text-muted">{t("section.instant")}</p>
    </fieldset>
  );
}
