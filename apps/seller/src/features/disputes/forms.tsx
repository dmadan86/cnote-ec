"use client";
import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, Field, Textarea } from "@cnote/ui";
import { hasFileEntries, submitFormAsAction } from "@cnote/next-kit/upload-client";
import { disputeAction, type DisputeResult } from "./actions";

// Text-only intents use the server action; submissions WITH evidence files go to POST /api/disputes (server actions are capped at 2 MB app-wide).
const useDispute = () =>
  useActionState<DisputeResult | null, FormData>(async (prev, fd) => (hasFileEntries(fd) ? submitFormAsAction<null>("/api/disputes", fd) : disputeAction(prev, fd)), null);
function Head({ intent, disputeId, state }: { intent: string; disputeId: string; state: DisputeResult | null }) {
  const t = useTranslations("disputes");
  return (
  <>
    <input type="hidden" name="intent" value={intent} />
    <input type="hidden" name="disputeId" value={disputeId} />
    {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
    {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
  </>
  );
}
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
  const t = useTranslations("disputes");
  const [state, action, pending] = useDispute();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Head intent={respond ? "respond" : "evidence"} disputeId={disputeId} state={state} />
      <Text label={respond ? t("yourResponse") : t("statement")} />
      <File name="photos" label={t("photoLabel")} accept="image/jpeg,image/png,image/webp" />
      <File name="documents" label={t("documentLabel")} accept="application/pdf" />
      <File name="voice" label={t("voiceLabel")} accept="audio/*" />
      <label className="flex min-h-11 items-start gap-2 text-sm text-ink"><input type="checkbox" name="voiceConsent" className="mt-1 size-5" />{t("voiceConsent")}</label>
      <div><Button type="submit" disabled={pending}>{respond ? t("sendResponse") : t("addEvidence")}</Button></div>
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
