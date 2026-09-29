"use client";
import { useActionState, useRef } from "react";
import { Alert, Field, Input, Select, Textarea } from "@cnote/ui";
import { UNITS } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { reportDealAction, sendMessageAction, sendQuoteAction, type ConvResult } from "./actions";

export function MessageForm({ conversationId }: { conversationId: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action] = useActionState<ConvResult | null, FormData>(async (prev, fd) => {
    const r = await sendMessageAction(prev, fd);
    if (r.ok) ref.current?.reset();
    return r;
  }, null);
  return (
    <form ref={ref} action={action} className="space-y-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <label htmlFor="body" className="sr-only">Message</label>
      <Textarea id="body" name="body" required maxLength={2000} placeholder="Write a message to the buyer" className="min-h-20 text-base" />
      <FormAlert state={state} />
      <SubmitButton pendingText="Sending…">Send message</SubmitButton>
    </form>
  );
}

export function QuoteForm({ conversationId }: { conversationId: string }) {
  const [state, action] = useActionState<ConvResult | null, FormData>(sendQuoteAction, null);
  return (
    <form action={action} key={state?.ok ? "sent" : "draft"} className="space-y-4">
      <input type="hidden" name="conversationId" value={conversationId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Price (₹ per unit)" htmlFor="q-price" error={fieldError(state, "price")}>
          <Input id="q-price" name="price" inputMode="decimal" required className="h-11" />
        </Field>
        <Field label="Quantity" htmlFor="q-qty" error={fieldError(state, "quantity")}>
          <Input id="q-qty" name="quantity" inputMode="decimal" required className="h-11" />
        </Field>
        <Field label="Unit" htmlFor="q-unit" error={fieldError(state, "unit")}>
          <Select id="q-unit" name="unit" defaultValue="pcs" className="h-11">{UNITS.map((u) => <option key={u}>{u}</option>)}</Select>
        </Field>
        <Field label="Delivery time (days)" htmlFor="q-lead" error={fieldError(state, "leadTimeDays")}>
          <Input id="q-lead" name="leadTimeDays" inputMode="numeric" className="h-11" />
        </Field>
        <Field label="Quote valid until" htmlFor="q-valid" error={fieldError(state, "validUntil")}>
          <Input id="q-valid" name="validUntil" type="date" className="h-11" />
        </Field>
      </div>
      <Field label="Notes (optional)" htmlFor="q-notes" hint="Payment terms, GST extra, packing, freight." error={fieldError(state, "notes")}>
        <Textarea id="q-notes" name="notes" maxLength={1000} />
      </Field>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">Quote sent to the buyer.</Alert> : null}
      <SubmitButton variant="accent" size="lg" pendingText="Sending…">Send quote</SubmitButton>
    </form>
  );
}

export function DealReportForm({ conversationId, matchId, current }: { conversationId: string; matchId: string; current: "won" | "lost" | "pending" | null }) {
  const [state, action] = useActionState<ConvResult | null, FormData>(reportDealAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="matchId" value={matchId} />
      <Field label="Deal value if won (₹, optional)" htmlFor="d-value" hint="Private. Helps us improve matching and your trust score." error={fieldError(state, "valueRupees")}>
        <Input id="d-value" name="valueRupees" inputMode="decimal" className="h-11 max-w-xs" />
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton name="outcome" value="won" variant={current === "won" ? "primary" : "outline"} pendingText="Saving…">Yes, we closed it</SubmitButton>
        <SubmitButton name="outcome" value="pending" variant={current === "pending" ? "primary" : "outline"} pendingText="Saving…">Still talking</SubmitButton>
        <SubmitButton name="outcome" value="lost" variant={current === "lost" ? "primary" : "outline"} pendingText="Saving…">No deal</SubmitButton>
      </div>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">Thanks, noted.</Alert> : null}
    </form>
  );
}
