"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Badge, Button, Field, Input, Textarea } from "@cnote/ui";
import { useActionState } from "react";
import { discardCounterAction, sendCounterAction, suggestCounterAction } from "./actions";
import { fmt, inr, type NegotiationLabels } from "./labels";

export function SuggestCounter({ enquiryId, quoteId, sellerName, labels: t }: { enquiryId: string; quoteId: string; sellerName: string; labels: NegotiationLabels }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(suggestCounterAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="enquiryId" value={enquiryId} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-busy={pending} className="min-h-11">
        {pending ? t.suggesting : t.suggest}
        <span className="sr-only"> ({sellerName})</span>
      </Button>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
    </form>
  );
}

export interface CounterData {
  id: string;
  quotedPaise: number;
  priceRupees: number;
  leadTimeDays: number | null;
  note: string;
  rationale: string;
  needsReview: boolean;
}

/** Editable proposal. "Send counter-offer" is the only control that contacts the seller. */
export function CounterEditor({ enquiryId, sellerName, unit, c, labels: t }: { enquiryId: string; sellerName: string; unit: string; c: CounterData; labels: NegotiationLabels }) {
  const [state, send, sending] = useActionState<ActionResult | null, FormData>(sendCounterAction, null);
  const [dState, discard, discarding] = useActionState<ActionResult | null, FormData>(discardCounterAction, null);
  const id = `neg-c-${c.id}`;
  return (
    <form action={send} className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4" aria-labelledby={`${id}-h`}>
      <input type="hidden" name="enquiryId" value={enquiryId} />
      <input type="hidden" name="proposalId" value={c.id} />
      <h4 id={`${id}-h`} className="text-sm font-semibold text-ink">{t.counterHeading}: {sellerName}</h4>
      <p className="text-sm text-muted">{fmt(t.counterQuoted, { price: inr(c.quotedPaise) })}</p>
      {c.needsReview ? <Badge tone="warning">{t.lowConfidence}</Badge> : null}
      <p className="text-sm text-ink"><span className="font-medium">{t.counterWhy}: </span>{c.rationale}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`${t.counterPrice} / ${unit}`} htmlFor={`${id}-price`}>
          <Input id={`${id}-price`} name="price" inputMode="decimal" required defaultValue={c.priceRupees} className="min-h-11" />
        </Field>
        <Field label={t.counterLead} htmlFor={`${id}-lead`}>
          <Input id={`${id}-lead`} name="lead" inputMode="numeric" defaultValue={c.leadTimeDays ?? ""} className="min-h-11" />
        </Field>
      </div>
      <Field label={t.counterNote} htmlFor={`${id}-note`}>
        <Textarea id={`${id}-note`} name="note" maxLength={1000} defaultValue={c.note} />
      </Field>
      <p className="text-sm font-medium text-ink">{t.counterNotSent}</p>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {dState && !dState.ok ? <Alert tone="danger">{dState.error}</Alert> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="accent" disabled={sending || discarding} aria-busy={sending} className="min-h-11">{sending ? t.counterSending : t.counterSend}</Button>
        <Button type="submit" formAction={discard} formNoValidate variant="outline" disabled={sending || discarding} className="min-h-11">{t.counterDiscard}</Button>
      </div>
    </form>
  );
}
