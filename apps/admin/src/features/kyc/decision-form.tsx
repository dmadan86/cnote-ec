"use client";
import { Textarea } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { decideKycAction } from "./actions";

/** Approve / Reject with a required note (kept on the session and in the audit log). */
export function KycDecisionForm({ id }: { id: string }) {
  return (
    <ActionForm action={decideKycAction} successMessage="Decision recorded." className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor="kyc-note" className="sr-only">Decision note (required)</label>
      <Textarea id="kyc-note" name="note" required minLength={3} maxLength={500} placeholder="Why? (required, e.g. Name differs but matches the proprietor's PAN; confirmed by phone)" className="min-h-20" />
      <div className="flex gap-2">
        <SubmitButton name="decision" value="approved" size="sm">Approve KYC</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="danger" size="sm">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}
