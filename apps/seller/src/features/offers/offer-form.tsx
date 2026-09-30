"use client";
import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, Field, Input, Select } from "@cnote/ui";
import { intlTag } from "@/i18n/config";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { createOfferAction, type OfferResult } from "./actions";

export interface ListingChoice {
  id: string;
  title: string;
  pricePaise: number | null;
  moq: number | null;
  /** platform-computed lowest 30-day price, or null when there is less than 30 days of history */
  referencePaise: number | null;
}

const KINDS = ["timed_price", "volume_tiers", "free_delivery_moq"] as const;

export function OfferForm({ listings }: { listings: ListingChoice[] }) {
  const t = useTranslations("offers");
  const locale = useLocale();
  const inr = (p: number) => `₹${(p / 100).toLocaleString(`${intlTag(locale)}-u-nu-latn`, { maximumFractionDigits: 2 })}`;
  const [state, action] = useActionState<OfferResult | null, FormData>(createOfferAction, null);
  const [listingId, setListingId] = useState(listings[0]?.id ?? "");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("timed_price");
  const [tiers, setTiers] = useState([0, 1]);
  const listing = listings.find((l) => l.id === listingId);

  if (listings.length === 0) return <Alert tone="info">{t("form.noListings")}</Alert>;
  return (
    <form action={action} className="space-y-5" noValidate>
      <Field label={t("form.listing")} htmlFor="o-listing" error={fieldError(state, "listingId")}>
        <Select id="o-listing" name="listingId" value={listingId} onChange={(e) => setListingId(e.target.value)}>
          {listings.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </Select>
      </Field>

      {listing ? (
        <p className="rounded-lg border border-line bg-canvas p-3 text-sm text-ink" aria-live="polite">
          {t.rich("form.currentPrice", { price: listing.pricePaise ? inr(listing.pricePaise) : t("form.notSet"), b: (c) => <strong>{c}</strong> })}
          {listing.moq ? <> · {t.rich("form.minOrder", { moq: listing.moq, b: (c) => <strong>{c}</strong> })}</> : null}
          <br />
          {listing.referencePaise ? (
            <>{t.rich("form.refWith", { price: inr(listing.referencePaise), b: (c) => <strong>{c}</strong> })}</>
          ) : (
            <>{t("form.noHistory")}</>
          )}
        </p>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">{t("form.offerType")}</legend>
        {KINDS.map((k) => (
          <label key={k} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="mt-1 size-4" />
            <span>
              <span className="block text-sm font-semibold text-ink">{t(`kind.${k}`)}</span>
              <span className="block text-xs text-muted">{t(`kindHint.${k}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind === "timed_price" ? (
        <Field label={t("form.priceLabel")} htmlFor="o-price" error={fieldError(state, "terms.unitPricePaise")} hint={t("form.priceHint")}>
          <Input id="o-price" name="unitPrice" inputMode="decimal" placeholder={t("form.pricePlaceholder")} />
        </Field>
      ) : null}

      {kind === "volume_tiers" ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">{t("form.tiersTitle")}</legend>
          <p className="text-xs text-muted">{t("form.tiersHelp")}</p>
          {tiers.map((key, i) => (
            <div key={key} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <Field label={t("form.tierQty", { n: i + 1 })} htmlFor={`t-q-${key}`}><Input id={`t-q-${key}`} name="tierQty" inputMode="numeric" /></Field>
              <Field label={t("form.tierPrice")} htmlFor={`t-p-${key}`}><Input id={`t-p-${key}`} name="tierPrice" inputMode="decimal" /></Field>
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setTiers((t) => t.filter((x) => x !== key))} disabled={tiers.length <= 1} aria-label={t("form.removeTier", { n: i + 1 })}>{t("form.remove")}</Button>
            </div>
          ))}
          {fieldError(state, "tiers") ? <p role="alert" className="text-xs text-danger">{fieldError(state, "tiers")}</p> : null}
          <Button type="button" variant="outline" className="min-h-11" disabled={tiers.length >= 5} onClick={() => setTiers((t) => [...t, Math.max(...t) + 1])}>{t("form.addTier")}</Button>
        </fieldset>
      ) : null}

      {kind === "free_delivery_moq" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("form.freeQty")} htmlFor="o-minqty" error={fieldError(state, "terms.minQty")}><Input id="o-minqty" name="minQty" inputMode="numeric" /></Field>
          <Field label={t("form.freeValue")} htmlFor="o-minval" error={fieldError(state, "terms")}><Input id="o-minval" name="minOrderValue" inputMode="decimal" /></Field>
          <div className="sm:col-span-2">
            <Field label={t("form.regions")} htmlFor="o-regions" hint={t("form.regionsHint")}><Input id="o-regions" name="regions" /></Field>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("form.starts")} htmlFor="o-start" hint={t("form.startsHint")}><Input id="o-start" name="startsAt" type="datetime-local" /></Field>
        <Field label={kind === "timed_price" ? t("form.endsRequired") : t("form.endsOptional")} htmlFor="o-end" error={fieldError(state, "endsAt")}><Input id="o-end" name="endsAt" type="datetime-local" /></Field>
      </div>

      <Alert tone="info">
        {t("form.honour")}
      </Alert>

      <SubmitButton pendingText={t("form.submitPending")}>{t("form.submit")}</SubmitButton>
      <FormAlert state={state} />
      {state?.ok ? (
        <Alert tone="success">
          {state.data.status === "needs_review" ? t("form.okReview") : state.data.status === "active" ? t("form.okLive") : t("form.okScheduled")}
        </Alert>
      ) : null}
    </form>
  );
}
