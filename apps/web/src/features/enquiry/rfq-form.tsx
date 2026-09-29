"use client";
import type { EnquiryView } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useActionState } from "react";
import { postRfqAction } from "./actions";
import { RfqResult } from "./rfq-result";

const UNITS = ["pcs", "kg", "ton", "meter", "set", "box", "litre"];

export interface RfqFormProps {
  categories: { slug: string; name: string }[];
  defaults?: { title?: string; requirement?: string; categorySlug?: string; preferredListingId?: string };
}

export function RfqForm({ categories, defaults }: RfqFormProps) {
  const [state, action, pending] = useActionState<ActionResult<EnquiryView> | null, FormData>(postRfqAction, null);
  if (state?.ok) return <RfqResult enquiry={state.data} />;
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {defaults?.preferredListingId ? <input type="hidden" name="preferredListingId" value={defaults.preferredListingId} /> : null}

      <Field label="What do you need?" htmlFor="title" error={err("title")} hint="A short title, e.g. 3-ply corrugated boxes">
        <Input id="title" name="title" required maxLength={140} defaultValue={defaults?.title} aria-invalid={!!err("title")} />
      </Field>
      <Field label="Requirement details" htmlFor="requirement" error={err("requirement")} hint="Size, material, finish, quality, anything a seller should know">
        <Textarea id="requirement" name="requirement" required rows={5} maxLength={4000} defaultValue={defaults?.requirement} aria-invalid={!!err("requirement")} />
      </Field>
      <Field label="Category" htmlFor="categorySlug" error={err("categorySlug")} hint="Helps us find the right sellers">
        <Select id="categorySlug" name="categorySlug" defaultValue={defaults?.categorySlug ?? ""}>
          <option value="">Not sure</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Quantity" htmlFor="quantity" error={err("quantity")}>
          <Input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} step={1} />
        </Field>
        <Field label="Unit" htmlFor="quantityUnit" error={err("quantityUnit")}>
          <Select id="quantityUnit" name="quantityUnit" defaultValue="pcs">
            {UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </Select>
        </Field>
        <Field label="Target price per unit (₹)" htmlFor="targetPrice" error={err("targetPricePaise")} hint="Optional">
          <Input id="targetPrice" name="targetPrice" type="number" inputMode="decimal" min={0} step="0.01" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Delivery city" htmlFor="deliveryCity" error={err("deliveryCity")}>
          <Input id="deliveryCity" name="deliveryCity" autoComplete="address-level2" />
        </Field>
        <Field label="Pincode" htmlFor="deliveryPincode" error={err("deliveryPincode")}>
          <Input id="deliveryPincode" name="deliveryPincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" />
        </Field>
        <Field label="Needed by" htmlFor="neededBy" error={err("neededBy")}>
          <Input id="neededBy" name="neededBy" type="date" />
        </Field>
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-sm">
        <input type="checkbox" name="buyerPicks" className="mt-0.5 size-4 accent-brand-600" />
        <span>
          <span className="font-medium text-ink">Let me pick the sellers</span>
          <span className="block text-muted">We show a ranked list and nothing is sent until you choose.</span>
        </span>
      </label>

      <p className="text-xs text-muted">
        Your requirement goes to at most 3 relevant sellers, never everyone. Your contact details stay hidden until a seller accepts.
      </p>
      <div>
        <Button type="submit" variant="accent" size="lg" disabled={pending}>
          {pending ? "Posting…" : "Post requirement"}
        </Button>
      </div>
    </form>
  );
}
