"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Input, Textarea } from "@cnote/ui";
import { useActionState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  assignAuditPartnerAction, createAuditPartnerAction, issueAuditLinkAction, resubmitAuditAction, reviewAuditSubmissionAction, toggleAuditPartnerAction,
} from "./actions";

const SELECT = "h-9 rounded-lg border border-line bg-surface px-2 text-sm";

export function NewPartnerForm() {
  return (
    <ActionForm action={createAuditPartnerAction} successMessage="Partner added." className="flex flex-wrap items-end gap-2">
      <div><label htmlFor="np-name" className="block text-xs text-muted">Partner agency</label><Input id="np-name" name="name" required minLength={2} maxLength={120} placeholder="e.g. SGS India" /></div>
      <div><label htmlFor="np-email" className="block text-xs text-muted">Contact email (optional)</label><Input id="np-email" name="contactEmail" type="email" maxLength={160} /></div>
      <SubmitButton size="sm">Add partner</SubmitButton>
    </ActionForm>
  );
}

export function PartnerToggle({ id, active }: { id: string; active: boolean }) {
  return (
    <ActionForm action={toggleAuditPartnerAction} successMessage="Updated." className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <SubmitButton size="sm" variant="outline">{active ? "Deactivate" : "Activate"}</SubmitButton>
    </ActionForm>
  );
}

export function AssignPartnerForm({ id, partners, current }: { id: string; partners: { id: string; name: string }[]; current: string | null }) {
  return (
    <ActionForm action={assignAuditPartnerAction} successMessage="Partner assigned." className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`ap-${id}`} className="sr-only">Audit partner</label>
      <select id={`ap-${id}`} name="partnerId" required defaultValue={current ?? ""} className={SELECT}>
        <option value="" disabled>Choose partner</option>
        {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <SubmitButton size="sm" variant="outline">Assign</SubmitButton>
    </ActionForm>
  );
}

/** Shows the single-use link once; the server stores only its hash, so a reload cannot show it again. */
export function IssueLinkForm({ id }: { id: string }) {
  const [state, action] = useActionState<ActionResult<{ url: string; expiresAt: string }> | null, FormData>(issueAuditLinkAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline">Issue partner upload link</SubmitButton>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? (
        <Alert tone="success">
          <p className="text-sm">Send this link to the partner. It works once and expires {new Date(state.data.expiresAt).toLocaleDateString("en-IN")}. It is shown only now.</p>
          <label htmlFor={`link-${id}`} className="sr-only">Partner upload link</label>
          <input id={`link-${id}`} readOnly value={state.data.url} onFocus={(e) => e.currentTarget.select()} className="mt-2 w-full rounded border border-line bg-surface px-2 py-1 font-mono text-xs" />
        </Alert>
      ) : null}
    </form>
  );
}

export function ReviewSubmissionForm({ id }: { id: string }) {
  return (
    <div className="space-y-3">
      <ActionForm action={reviewAuditSubmissionAction} confirm="Record this result? A pass lifts the business to Tier 3. It is written to the audit log." successMessage="Result recorded." className="space-y-2">
        <input type="hidden" name="id" value={id} />
        <label htmlFor={`rn-${id}`} className="sr-only">Review note</label>
        <Textarea id={`rn-${id}`} name="note" required maxLength={2000} placeholder="Review note: what you checked and why this result" className="min-h-16" />
        <div className="flex flex-wrap items-end gap-2">
          <div><label htmlFor={`rr-${id}`} className="block text-xs text-muted">Result</label>
            <select id={`rr-${id}`} name="result" className={SELECT}><option value="pass">Pass</option><option value="conditional">Conditional</option><option value="fail">Fail</option></select></div>
          <div><label htmlFor={`rv-${id}`} className="block text-xs text-muted">Valid until (re-audit prompt 30 days before)</label><Input id={`rv-${id}`} name="validUntil" type="date" required className="w-44" /></div>
          <SubmitButton size="sm">Record result</SubmitButton>
        </div>
      </ActionForm>
      <ActionForm action={resubmitAuditAction} confirm="Send back to the partner? Their photos are deleted and a new link must be issued." successMessage="Sent back." className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={id} />
        <div><label htmlFor={`sb-${id}`} className="block text-xs text-muted">Or send back to the partner</label><Input id={`sb-${id}`} name="note" required minLength={3} maxLength={500} placeholder="What needs fixing" className="w-80" /></div>
        <SubmitButton size="sm" variant="outline">Send back</SubmitButton>
      </ActionForm>
    </div>
  );
}
