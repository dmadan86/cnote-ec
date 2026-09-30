"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button } from "@cnote/ui";
import { useActionState, useId } from "react";
import { bnplAction } from "./actions";

export interface BnplLabels {
  consent: string; tenor: string; tenorOptions: { value: number; label: string }[]; apply: string; noAuto: string; error: string;
  acknowledge: string; accept: string; decline: string; simulate: string;
  exitConfirm: string; exitSubmit: string;
}

function Status({ state, error }: { state: ActionResult | null; error: string }) {
  return <div role="status" aria-live="polite">{state && !state.ok ? <Alert tone="danger">{state.error || error}</Alert> : null}</div>;
}

/** Explicit consent + tenor, then "see offer". Nothing is charged and nothing is accepted by this form. */
export function BnplApplyForm({ orderId, escrowId, needsConsent, labels }: { orderId: string; escrowId: string; needsConsent: boolean; labels: BnplLabels }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(bnplAction, null);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="escrowId" value={escrowId} />
      <input type="hidden" name="intent" value="apply" />
      <Status state={state} error={labels.error} />
      {needsConsent ? (
        <label htmlFor={`${id}-consent`} className="flex min-h-11 items-start gap-2 text-sm text-ink">
          <input id={`${id}-consent`} type="checkbox" name="consent" required className="mt-1 size-5" />
          <span>{labels.consent}</span>
        </label>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-tenor`} className="text-sm font-medium text-ink">{labels.tenor}</label>
        <select id={`${id}-tenor`} name="tenorDays" defaultValue="30" className="min-h-11 rounded-md border border-border bg-white px-3 text-sm">
          {labels.tenorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <p className="text-sm text-muted">{labels.noAuto}</p>
      <div><Button type="submit" disabled={pending} className="min-h-11">{labels.apply}</Button></div>
    </form>
  );
}

export function BnplAcceptForm({ orderId, offerId, kfsVersion, labels }: { orderId: string; offerId: string; kfsVersion: string; labels: BnplLabels }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(bnplAction, null);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="kfsVersion" value={kfsVersion} />
      <Status state={state} error={labels.error} />
      <label htmlFor={`${id}-ack`} className="flex min-h-11 items-start gap-2 text-sm text-ink">
        <input id={`${id}-ack`} type="checkbox" name="acknowledge" required className="mt-1 size-5" />
        <span>{labels.acknowledge}</span>
      </label>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="intent" value="accept" disabled={pending} className="min-h-11">{labels.accept}</Button>
        <Button type="submit" name="intent" value="decline" variant="outline" formNoValidate disabled={pending} className="min-h-11">{labels.decline}</Button>
      </div>
    </form>
  );
}

export function BnplSimulateForm({ orderId, applicationId, label, error }: { orderId: string; applicationId: string; label: string; error: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(bnplAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="intent" value="simulate" />
      <Status state={state} error={error} />
      <div><Button type="submit" variant="outline" disabled={pending} className="min-h-11">{label}</Button></div>
    </form>
  );
}

/** Cooling-off exit (RBI): the exact amount is shown above; exit needs its own explicit confirmation of that amount. */
export function BnplExitForm({ orderId, loanId, payablePaise, labels }: { orderId: string; loanId: string; payablePaise: number; labels: BnplLabels }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(bnplAction, null);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="expectedPayablePaise" value={payablePaise} />
      <input type="hidden" name="intent" value="exit" />
      <Status state={state} error={labels.error} />
      <label htmlFor={`${id}-exit`} className="flex min-h-11 items-start gap-2 text-sm text-ink">
        <input id={`${id}-exit`} type="checkbox" name="confirmExit" required className="mt-1 size-5" />
        <span>{labels.exitConfirm}</span>
      </label>
      <div><Button type="submit" variant="outline" disabled={pending} className="min-h-11">{labels.exitSubmit}</Button></div>
    </form>
  );
}
