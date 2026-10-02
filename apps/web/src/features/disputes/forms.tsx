"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Textarea } from "@cnote/ui";
import { useActionState, useId, type ReactNode } from "react";
import { hasFileEntries, submitFormAsAction } from "@cnote/next-kit/upload-client";
import { disputeAction } from "./actions";
import { DISPUTE_TYPES, type DisputeLabels } from "./types";

type L = DisputeLabels;
// Text-only intents use the server action; submissions WITH evidence files go to POST /api/disputes (server actions are capped at 2 MB app-wide).
const useDispute = () =>
  useActionState<ActionResult | null, FormData>(async (prev, fd) => {
    if (!hasFileEntries(fd)) return disputeAction(prev, fd);
    const r = await submitFormAsAction<{ created: string | null }>("/api/disputes", fd, { refreshUrl: "/api/me" });
    return r.ok ? { ok: true, data: undefined } : r;
  }, null);
const FileInput = ({ name, label, accept, multiple, hint }: { name: string; label: string; accept: string; multiple?: boolean; hint?: string }) => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
      <input id={id} name={name} type="file" accept={accept} multiple={multiple} aria-describedby={hint ? `${id}-h` : undefined} className="min-h-11 text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-white file:px-3" />
      {hint ? <p id={`${id}-h`} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
};
function Ta({ label, hint, ...rest }: { label: string; hint?: string; name: string; rows?: number; required?: boolean; minLength?: number; maxLength?: number }) {
  const id = useId();
  return <Field label={label} htmlFor={id} hint={hint}><Textarea id={id} {...rest} /></Field>;
}
function Num({ label, hint, ...rest }: { label: string; hint?: string; name: string; min?: number; step?: string; inputMode?: "decimal" }) {
  const id = useId();
  return <Field label={label} htmlFor={id} hint={hint}><Input id={id} type="number" {...rest} /></Field>;
}
const Consent = ({ label }: { label: string }) => (
  <label className="flex min-h-11 items-start gap-2 text-sm text-ink"><input type="checkbox" name="voiceConsent" className="mt-1 size-5" />{label}</label>
);
const Errors = ({ state, generic }: { state: ActionResult | null; generic: string }) =>
  state && !state.ok ? <Alert tone="danger">{state.error || generic}</Alert> : null;

/** "Report a problem" form on the order page. Radio group (Etsy help-request pattern), details, amount, evidence. */
export function ReportForm({ orderId, labels: l }: { orderId: string; labels: L }) {
  const [state, action, pending] = useDispute();
  const legend = useId();
  return (
    <form action={action} className="flex flex-col gap-4" aria-busy={pending}>
      <input type="hidden" name="intent" value="open" />
      <input type="hidden" name="orderId" value={orderId} />
      <Errors state={state} generic={l.errorGeneric} />
      <fieldset className="flex flex-col gap-1" aria-labelledby={legend}>
        <legend id={legend} className="text-sm font-medium text-ink">{l.issueLabel}</legend>
        {DISPUTE_TYPES.map((t, i) => (
          <label key={t} className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input type="radio" name="type" value={t} required defaultChecked={i === 0} className="size-5" />
            {l[`type_${t}` as keyof L]}
          </label>
        ))}
      </fieldset>
      <Ta label={l.detailsLabel} hint={l.detailsHint} name="text" rows={4} maxLength={4000} />
      <Num label={l.amountLabel} hint={l.amountHint} name="amountRupees" min={0} step="0.01" inputMode="decimal" />
      <FileInput name="photos" label={l.photosLabel} accept="image/jpeg,image/png,image/webp" multiple />
      <FileInput name="documents" label={l.documentLabel} accept="application/pdf" multiple />
      <FileInput name="voice" label={l.voiceLabel} accept="audio/*" />
      <Consent label={l.voiceConsent} />
      <div><Button type="submit" disabled={pending}>{l.submit}</Button></div>
    </form>
  );
}

const Simple = ({ intent, disputeId, children, state }: { intent: string; disputeId: string; children: ReactNode; state: ActionResult | null }) => (
  <>
    <input type="hidden" name="intent" value={intent} />
    <input type="hidden" name="disputeId" value={disputeId} />
    {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
    {children}
  </>
);

export function RespondForm({ disputeId, labels: l, respond }: { disputeId: string; labels: L; respond: boolean }) {
  const [state, action, pending] = useDispute();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Simple intent={respond ? "respond" : "evidence"} disputeId={disputeId} state={state}>
        <Ta label={l.statementLabel} name="text" rows={3} maxLength={4000} />
        <FileInput name="photos" label={l.photosLabel} accept="image/jpeg,image/png,image/webp" />
        <FileInput name="voice" label={l.voiceLabel} accept="audio/*" />
        <Consent label={l.voiceConsent} />
        <div><Button type="submit" disabled={pending}>{respond ? l.respond : l.add}</Button></div>
      </Simple>
    </form>
  );
}

export function IntentButton({ disputeId, intent, label, variant = "outline" }: { disputeId: string; intent: "withdraw" | "escalate"; label: string; variant?: "outline" | "primary" }) {
  const [state, action, pending] = useDispute();
  return (
    <form action={action} className="flex flex-col gap-2">
      <Simple intent={intent} disputeId={disputeId} state={state}><div><Button type="submit" variant={variant} disabled={pending}>{label}</Button></div></Simple>
    </form>
  );
}

export function TextForm({ disputeId, intent, label, submit, sent, labels: l }: { disputeId: string; intent: "appeal" | "message"; label: string; submit: string; sent?: string; labels: L }) {
  const [state, action, pending] = useDispute();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Simple intent={intent} disputeId={disputeId} state={state}>
        {state?.ok && sent ? <Alert tone="success">{sent}</Alert> : null}
        <Ta label={label} name="text" rows={3} required minLength={intent === "appeal" ? 10 : 1} maxLength={2000} />
        <div><Button type="submit" disabled={pending}>{pending ? l.send : submit}</Button></div>
      </Simple>
    </form>
  );
}
