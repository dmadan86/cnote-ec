"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { adjudicateAction, appealAction, messageAction } from "@/app/(console)/disputes/actions";

const field = "mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";

export function DecisionForm({ disputeId, atStakeRupees, hasBrief, recommended }: { disputeId: string; atStakeRupees: number; hasBrief: boolean; recommended: string | null }) {
  return (
    <ActionForm action={adjudicateAction} confirm="Record this decision? It releases or refunds the held funds and cannot be undone." successMessage="Decision recorded.">
      <input type="hidden" name="disputeId" value={disputeId} />
      <div className="grid gap-3 sm:grid-cols-2">
        {hasBrief ? (
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="accept" className="size-5" />
            Accept the AI recommendation as written{recommended ? ` (${recommended.replace("_", " ")})` : ""}. The outcome and amount below are then ignored.
          </label>
        ) : null}
        <label className="text-xs">Outcome
          <select name="outcome" required defaultValue={recommended ?? "split"} className={`${field} h-10`}>
            <option value="buyer_favour">In favour of the buyer (full refund)</option>
            <option value="seller_favour">In favour of the seller (full release)</option>
            <option value="split">Split</option>
          </select>
        </label>
        <label className="text-xs">Refund to buyer, INR (split only; held: {atStakeRupees.toFixed(2)})
          <input name="refundRupees" type="number" step="0.01" min="0" max={atStakeRupees} className={`${field} h-10`} />
        </label>
        <label className="text-xs sm:col-span-2">Reason (shown to both parties)
          <textarea name="rationale" required minLength={10} maxLength={2000} rows={3} className={field} />
        </label>
      </div>
      <div className="mt-3"><SubmitButton>Record decision</SubmitButton></div>
    </ActionForm>
  );
}

export function AppealForm({ disputeId, appealId, atStakeRupees }: { disputeId: string; appealId: string; atStakeRupees: number }) {
  return (
    <ActionForm action={appealAction} confirm="Record this appeal decision?" successMessage="Appeal decided.">
      <input type="hidden" name="disputeId" value={disputeId} />
      <input type="hidden" name="appealId" value={appealId} />
      <input type="hidden" name="atStakeRupees" value={atStakeRupees} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs">Result
          <select name="status" className={`${field} h-10`}><option value="upheld">Original decision stands</option><option value="modified">Modify the outcome</option></select>
        </label>
        <label className="text-xs">New outcome (if modified)
          <select name="newOutcome" className={`${field} h-10`}><option value="">-</option><option value="buyer_favour">Buyer</option><option value="seller_favour">Seller</option><option value="split">Split</option></select>
        </label>
        <label className="text-xs">New refund, INR (split)
          <input name="newRefundRupees" type="number" step="0.01" min="0" max={atStakeRupees} className={`${field} h-10`} />
        </label>
        <label className="text-xs sm:col-span-3">Note
          <textarea name="note" required minLength={10} maxLength={2000} rows={2} className={field} />
        </label>
      </div>
      <div className="mt-3"><SubmitButton size="sm">Decide appeal</SubmitButton></div>
    </ActionForm>
  );
}

export function StaffMessageForm({ disputeId, partyBusinessId, label }: { disputeId: string; partyBusinessId: string; label: string }) {
  return (
    <ActionForm action={messageAction} successMessage="Sent.">
      <input type="hidden" name="disputeId" value={disputeId} />
      <input type="hidden" name="partyBusinessId" value={partyBusinessId} />
      <label className="text-xs">{label}
        <textarea name="body" required maxLength={2000} rows={2} className={field} />
      </label>
      <div className="mt-2"><SubmitButton size="sm" variant="outline">Send</SubmitButton></div>
    </ActionForm>
  );
}
