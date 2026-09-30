"use client";
import { useActionState, useId } from "react";
import { Alert, Button, Field, Textarea } from "@cnote/ui";
import { disputeAction, type DisputeResult } from "./actions";

const useDispute = () => useActionState<DisputeResult | null, FormData>(disputeAction, null);
const Head = ({ intent, disputeId, state }: { intent: string; disputeId: string; state: DisputeResult | null }) => (
  <>
    <input type="hidden" name="intent" value={intent} />
    <input type="hidden" name="disputeId" value={disputeId} />
    {state && !state.ok ? <Alert tone="danger"><span role="alert">{state.error}</span></Alert> : null}
    {state?.ok ? <Alert tone="success"><span role="status">Saved.</span></Alert> : null}
  </>
);
function File({ name, label, accept }: { name: string; label: string; accept: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
      <input id={id} name={name} type="file" accept={accept} className="min-h-11 text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-white file:px-3" />
    </div>
  );
}
function Text({ label, name = "text", required }: { label: string; name?: string; required?: boolean }) {
  const id = useId();
  return <Field label={label} htmlFor={id}><Textarea id={id} name={name} rows={3} maxLength={4000} required={required} /></Field>;
}

/** Respond (first statement from the counterparty) or add evidence (any later statement/file). */
export function EvidenceForm({ disputeId, respond }: { disputeId: string; respond: boolean }) {
  const [state, action, pending] = useDispute();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Head intent={respond ? "respond" : "evidence"} disputeId={disputeId} state={state} />
      <Text label={respond ? "Your response" : "Statement"} />
      <File name="photos" label="Photo (JPEG, PNG or WebP)" accept="image/jpeg,image/png,image/webp" />
      <File name="documents" label="Document (PDF), for example proof of delivery or an invoice" accept="application/pdf" />
      <File name="voice" label="Voice note (any Indian language)" accept="audio/*" />
      <label className="flex min-h-11 items-start gap-2 text-sm text-ink"><input type="checkbox" name="voiceConsent" className="mt-1 size-5" />I agree that my voice note may be stored and transcribed to help resolve this dispute.</label>
      <div><Button type="submit" disabled={pending}>{respond ? "Send response" : "Add evidence"}</Button></div>
    </form>
  );
}

export function IntentButton({ disputeId, intent, label }: { disputeId: string; intent: "escalate" | "withdraw"; label: string }) {
  const [state, action, pending] = useDispute();
  return (
    <form action={action} className="flex flex-col gap-2">
      <Head intent={intent} disputeId={disputeId} state={state} />
      <div><Button type="submit" variant="outline" disabled={pending}>{label}</Button></div>
    </form>
  );
}

export function TextForm({ disputeId, intent, label, submit }: { disputeId: string; intent: "appeal" | "message"; label: string; submit: string }) {
  const [state, action, pending] = useDispute();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Head intent={intent} disputeId={disputeId} state={state} />
      <Text label={label} required />
      <div><Button type="submit" disabled={pending}>{submit}</Button></div>
    </form>
  );
}
