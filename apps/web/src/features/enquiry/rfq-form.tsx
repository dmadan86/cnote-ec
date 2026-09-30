"use client";
import type { EnquiryView } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { postRfqAction } from "./actions";
import { RfqResult } from "./rfq-result";

const UNITS = ["pcs", "kg", "ton", "meter", "set", "box", "litre"];

export interface RfqFormProps {
  categories: { slug: string; name: string }[];
  defaults?: { title?: string; requirement?: string; categorySlug?: string; preferredListingId?: string; preferredSellerId?: string };
}

export function RfqForm({ categories, defaults }: RfqFormProps) {
  const t = useTranslations("rfq");
  const tb = useTranslations("buyer");
  const [state, action, pending] = useActionState<ActionResult<EnquiryView> | null, FormData>(postRfqAction, null);
  if (state?.ok) return <RfqResult enquiry={state.data} />;
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {defaults?.preferredListingId ? <input type="hidden" name="preferredListingId" value={defaults.preferredListingId} /> : null}
      {defaults?.preferredSellerId ? <input type="hidden" name="preferredSellerId" value={defaults.preferredSellerId} /> : null}

      <Field label={t("whatYouNeed")} htmlFor="title" error={err("title")} hint={t("whatYouNeedHint")}>
        <Input id="title" name="title" required maxLength={140} defaultValue={defaults?.title} aria-invalid={!!err("title")} />
      </Field>
      <Field label={t("details")} htmlFor="requirement" error={err("requirement")} hint={t("detailsHint")}>
        <Textarea id="requirement" name="requirement" required rows={5} maxLength={4000} defaultValue={defaults?.requirement} aria-invalid={!!err("requirement")} />
      </Field>
      <Field label={t("category")} htmlFor="categorySlug" error={err("categorySlug")} hint={t("categoryHint")}>
        <Select id="categorySlug" name="categorySlug" defaultValue={defaults?.categorySlug ?? ""}>
          <option value="">{t("notSure")}</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("quantity")} htmlFor="quantity" error={err("quantity")}>
          <Input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} step={1} />
        </Field>
        <Field label={t("unit")} htmlFor="quantityUnit" error={err("quantityUnit")}>
          <Select id="quantityUnit" name="quantityUnit" defaultValue="pcs">
            {UNITS.map((u) => (
              <option key={u} value={u}>{tb(`unit.${u}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("targetPrice")} htmlFor="targetPrice" error={err("targetPricePaise")} hint={t("optional")}>
          <Input id="targetPrice" name="targetPrice" type="number" inputMode="decimal" min={0} step="0.01" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("deliveryCity")} htmlFor="deliveryCity" error={err("deliveryCity")}>
          <Input id="deliveryCity" name="deliveryCity" autoComplete="address-level2" />
        </Field>
        <Field label={t("pincode")} htmlFor="deliveryPincode" error={err("deliveryPincode")}>
          <Input id="deliveryPincode" name="deliveryPincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" />
        </Field>
        <Field label={t("neededBy")} htmlFor="neededBy" error={err("neededBy")}>
          <Input id="neededBy" name="neededBy" type="date" />
        </Field>
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-sm">
        <input type="checkbox" name="buyerPicks" className="mt-0.5 size-4 accent-brand-600" />
        <span>
          <span className="font-medium text-ink">{t("pickSellers")}</span>
          <span className="block text-muted">{t("pickSellersHint")}</span>
        </span>
      </label>

      <p className="text-xs text-muted">
        {t("privacy")}
      </p>
      <div>
        <Button type="submit" variant="accent" size="lg" disabled={pending}>
          {pending ? t("posting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}
