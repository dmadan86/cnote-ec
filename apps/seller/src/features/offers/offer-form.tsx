"use client";
import { useActionState, useState } from "react";
import { Alert, Button, Field, Input, Select } from "@cnote/ui";
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

const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const KINDS = [
  { value: "timed_price", label: "Limited-time price", hint: "A lower unit price for up to 30 days. A 14-day gap is needed before the next one." },
  { value: "volume_tiers", label: "Volume pricing", hint: "Lower unit prices as the order quantity grows (up to 5 tiers)." },
  { value: "free_delivery_moq", label: "Free delivery", hint: "Free delivery above a quantity or order value, optionally for chosen regions." },
] as const;

export function OfferForm({ listings }: { listings: ListingChoice[] }) {
  const [state, action] = useActionState<OfferResult | null, FormData>(createOfferAction, null);
  const [listingId, setListingId] = useState(listings[0]?.id ?? "");
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("timed_price");
  const [tiers, setTiers] = useState([0, 1]);
  const listing = listings.find((l) => l.id === listingId);

  if (listings.length === 0) return <Alert tone="info">Publish a listing with a price first. Offers run on live listings.</Alert>;
  return (
    <form action={action} className="space-y-5" noValidate>
      <Field label="Listing" htmlFor="o-listing" error={fieldError(state, "listingId")}>
        <Select id="o-listing" name="listingId" value={listingId} onChange={(e) => setListingId(e.target.value)}>
          {listings.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </Select>
      </Field>

      {listing ? (
        <p className="rounded-lg border border-line bg-canvas p-3 text-sm text-ink" aria-live="polite">
          Current price: <strong>{listing.pricePaise ? inr(listing.pricePaise) : "not set"}</strong>
          {listing.moq ? <> · Minimum order: <strong>{listing.moq}</strong></> : null}
          <br />
          {listing.referencePaise ? (
            <>Buyers compare your offer with <strong>{inr(listing.referencePaise)}</strong>, the lowest price this listing had in the last 30 days. We work this out from your price history. You cannot type it.</>
          ) : (
            <>This listing does not have 30 days of price history yet, so buyers will see your offer price only, with no &ldquo;was&rdquo; price and no percentage.</>
          )}
        </p>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Offer type</legend>
        {KINDS.map((k) => (
          <label key={k.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
            <input type="radio" name="kind" value={k.value} checked={kind === k.value} onChange={() => setKind(k.value)} className="mt-1 size-4" />
            <span>
              <span className="block text-sm font-semibold text-ink">{k.label}</span>
              <span className="block text-xs text-muted">{k.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind === "timed_price" ? (
        <Field label="Offer price per unit (₹)" htmlFor="o-price" error={fieldError(state, "terms.unitPricePaise")} hint="Must be at least 3% below your lowest price of the last 30 days.">
          <Input id="o-price" name="unitPrice" inputMode="decimal" placeholder="e.g. 42.50" />
        </Field>
      ) : null}

      {kind === "volume_tiers" ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Price tiers</legend>
          <p className="text-xs text-muted">Quantities must grow and prices must fall. The first tier starts at or above your minimum order.</p>
          {tiers.map((key, i) => (
            <div key={key} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <Field label={`Tier ${i + 1}: from quantity`} htmlFor={`t-q-${key}`}><Input id={`t-q-${key}`} name="tierQty" inputMode="numeric" /></Field>
              <Field label="Price per unit (₹)" htmlFor={`t-p-${key}`}><Input id={`t-p-${key}`} name="tierPrice" inputMode="decimal" /></Field>
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setTiers((t) => t.filter((x) => x !== key))} disabled={tiers.length <= 1} aria-label={`Remove tier ${i + 1}`}>Remove</Button>
            </div>
          ))}
          {fieldError(state, "tiers") ? <p role="alert" className="text-xs text-danger">{fieldError(state, "tiers")}</p> : null}
          <Button type="button" variant="outline" className="min-h-11" disabled={tiers.length >= 5} onClick={() => setTiers((t) => [...t, Math.max(...t) + 1])}>Add a tier</Button>
        </fieldset>
      ) : null}

      {kind === "free_delivery_moq" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Free delivery from quantity" htmlFor="o-minqty" error={fieldError(state, "terms.minQty")}><Input id="o-minqty" name="minQty" inputMode="numeric" /></Field>
          <Field label="or from order value (₹)" htmlFor="o-minval" error={fieldError(state, "terms")}><Input id="o-minval" name="minOrderValue" inputMode="decimal" /></Field>
          <div className="sm:col-span-2">
            <Field label="Regions (optional, comma separated)" htmlFor="o-regions" hint="e.g. Karnataka, Tamil Nadu. Leave empty for all of India."><Input id="o-regions" name="regions" /></Field>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts (India time)" htmlFor="o-start" hint="Leave empty to start now."><Input id="o-start" name="startsAt" type="datetime-local" /></Field>
        <Field label={kind === "timed_price" ? "Ends (India time)" : "Ends (optional)"} htmlFor="o-end" error={fieldError(state, "endsAt")}><Input id="o-end" name="endsAt" type="datetime-local" /></Field>
      </div>

      <Alert tone="info">
        You must honour this offer for enquiries that meet its terms. Buyers can report an offer that was not honoured, and repeated upheld reports pause offers on your account. Offers never change your search ranking.
      </Alert>

      <SubmitButton pendingText="Checking…">Create offer</SubmitButton>
      <FormAlert state={state} />
      {state?.ok ? (
        <Alert tone="success">
          {state.data.status === "needs_review" ? "Your offer is with our team for a quick check (it is a large discount or needs a second look). We will notify you." : state.data.status === "active" ? "Your offer is live." : "Your offer is scheduled and starts automatically."}
        </Alert>
      ) : null}
    </form>
  );
}
