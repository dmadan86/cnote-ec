"use client";
import type { ActionResult } from "@cnote/next-kit";
import { hasFileEntries, submitFormAsAction } from "@cnote/next-kit/upload-client";
import { Alert, Button, Field, Input, Textarea } from "@cnote/ui";
import { useActionState, useId, useState } from "react";
import { sampleAction } from "./actions";
import type { SampleLabels } from "./labels";

const REJECT_REASONS = ["quality_below_spec", "dimensions_off", "material_mismatch", "finish_defect", "colour_mismatch", "packaging_damaged", "not_as_described", "other"] as const;

// Text-only intents use the server action; an evaluation WITH photos goes to POST /api/samples (server actions are capped at 2 MB app-wide).
const useSample = () =>
  useActionState<ActionResult | null, FormData>(async (prev, fd) => {
    if (!hasFileEntries(fd)) return sampleAction(prev, fd);
    const r = await submitFormAsAction<{ created: string | null }>("/api/samples", fd, { refreshUrl: "/api/me" });
    return r.ok ? { ok: true, data: undefined } : r;
  }, null);

const Errors = ({ state, generic }: { state: ActionResult | null; generic: string }) =>
  state && !state.ok ? <Alert tone="danger">{state.error || generic}</Alert> : null;

/** The request form: used inside the PDP dialog and on the full-page /buyer/samples/new. */
export function RequestSampleForm({
  labels: l, listingId, conversationId, quoteId, maxQty, defaultQty = 1, idPrefix = "rs",
}: { labels: SampleLabels; listingId?: string; conversationId?: string; quoteId?: string; maxQty?: number; defaultQty?: number; idPrefix?: string }) {
  const [state, action, pending] = useSample();
  const uid = useId();
  const id = (n: string) => `${idPrefix}-${uid}-${n}`;
  return (
    <form action={action} className="flex flex-col gap-4" aria-busy={pending}>
      <input type="hidden" name="intent" value="request" />
      {listingId ? <input type="hidden" name="listingId" value={listingId} /> : null}
      {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
      {quoteId ? <input type="hidden" name="quoteId" value={quoteId} /> : null}
      <Errors state={state} generic={l.errorGeneric} />
      <Field label={l.quantityLabel} htmlFor={id("qty")}>
        <Input id={id("qty")} name="quantity" type="number" inputMode="numeric" min={1} max={maxQty} step={1} defaultValue={defaultQty} required />
      </Field>
      <Field label={l.noteLabel} htmlFor={id("note")}>
        <Textarea id={id("note")} name="note" rows={2} maxLength={1000} />
      </Field>
      <fieldset className="flex flex-col gap-3 rounded-card border border-line p-3">
        <legend className="px-1 text-sm font-semibold text-ink">{l.shipLegend}</legend>
        <p className="text-xs text-muted">{l.shipHint}</p>
        <Field label={l.fieldName} htmlFor={id("name")}>
          <Input id={id("name")} name="name" autoComplete="name" required maxLength={100} />
        </Field>
        <Field label={l.fieldPhone} htmlFor={id("phone")}>
          <Input id={id("phone")} name="phone" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={16} />
        </Field>
        <Field label={l.fieldLine1} htmlFor={id("line1")}>
          <Input id={id("line1")} name="line1" autoComplete="address-line1" required maxLength={160} />
        </Field>
        <Field label={l.fieldLine2} htmlFor={id("line2")}>
          <Input id={id("line2")} name="line2" autoComplete="address-line2" maxLength={160} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={l.fieldCity} htmlFor={id("city")}>
            <Input id={id("city")} name="city" autoComplete="address-level2" required maxLength={80} />
          </Field>
          <Field label={l.fieldPincode} htmlFor={id("pin")}>
            <Input id={id("pin")} name="pincode" inputMode="numeric" autoComplete="postal-code" pattern="[1-9][0-9]{5}" maxLength={6} required />
          </Field>
        </div>
      </fieldset>
      <p className="text-xs text-muted">{l.slaNote}</p>
      <div><Button type="submit" disabled={pending}>{pending ? l.working : l.submitRequest}</Button></div>
    </form>
  );
}

/** A one-button intent form (cancel, mark received, accept the linked quote). */
export function IntentButton({ sampleId, intent, label, variant = "outline", labels: l }: { sampleId: string; intent: "cancel" | "received" | "acceptQuote"; label: string; variant?: "outline" | "primary"; labels: SampleLabels }) {
  const [state, action, pending] = useSample();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="sampleId" value={sampleId} />
      <Errors state={state} generic={l.errorGeneric} />
      <div><Button type="submit" variant={variant} disabled={pending}>{pending ? l.working : label}</Button></div>
    </form>
  );
}

/** Verdict + structured reasons + notes + photos (Zillow-style structured review, GetYourGuide-style photo strip: docs/design/samples.md). */
export function EvaluateForm({ sampleId, labels: l }: { sampleId: string; labels: SampleLabels }) {
  const [state, action, pending] = useSample();
  const [verdict, setVerdict] = useState<"approve" | "reject">("approve");
  const uid = useId();
  const photosId = `${uid}-photos`;
  const reasonsId = `${uid}-reasons`;
  return (
    <form action={action} className="flex flex-col gap-4" aria-busy={pending}>
      <input type="hidden" name="intent" value="evaluate" />
      <input type="hidden" name="sampleId" value={sampleId} />
      <Errors state={state} generic={l.errorGeneric} />
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium text-ink">{l.verdictLegend}</legend>
        {(["approve", "reject"] as const).map((v) => (
          <label key={v} className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input type="radio" name="verdict" value={v} checked={verdict === v} onChange={() => setVerdict(v)} className="size-5" />
            {v === "approve" ? l.verdictApprove : l.verdictReject}
          </label>
        ))}
      </fieldset>
      {verdict === "reject" ? (
        <fieldset className="flex flex-col gap-1" aria-describedby={reasonsId}>
          <legend id={reasonsId} className="text-sm font-medium text-ink">{l.reasonsLegend}</legend>
          {REJECT_REASONS.map((r) => (
            <label key={r} className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="reasons" value={r} className="size-5" />
              {l[`reject_${r}` as keyof SampleLabels]}
            </label>
          ))}
        </fieldset>
      ) : null}
      <Field label={l.notesLabel} htmlFor={`${uid}-notes`}>
        <Textarea id={`${uid}-notes`} name="notes" rows={3} maxLength={2000} />
      </Field>
      <div className="flex flex-col gap-1">
        <label htmlFor={photosId} className="text-sm font-medium text-ink">{l.photosLabel}</label>
        <input id={photosId} name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-describedby={`${photosId}-h`} className="min-h-11 text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-white file:px-3" />
        <p id={`${photosId}-h`} className="text-xs text-muted">{l.photosHint}</p>
      </div>
      <div><Button type="submit" disabled={pending}>{pending ? l.working : l.saveVerdict}</Button></div>
    </form>
  );
}
