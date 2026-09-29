"use client";
import { useActionState, useState } from "react";
import { Alert, Button } from "@cnote/ui";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { cancelPlanAction, subscribeAction, type BillingResult } from "./actions";

export function SubscribeButton({ planCode, label, current }: { planCode: string; label: string; current: boolean }) {
  const [state, action] = useActionState<BillingResult | null, FormData>(subscribeAction, null);
  if (current) return <p className="text-sm font-medium text-success">Your current plan</p>;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="planCode" value={planCode} />
      <SubmitButton variant="outline-brand" className="w-full" pendingText="Starting…">{label}</SubmitButton>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">Plan started. Credits added.</Alert> : null}
    </form>
  );
}

/** ADR-005: cancel in at most 3 taps: "Cancel plan" (1) -> "Yes, cancel" (2). */
export function CancelPlan({ endsOn }: { endsOn: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action] = useActionState<BillingResult | null, FormData>(cancelPlanAction, null);
  if (!confirming) return <Button variant="outline" className="min-h-11" onClick={() => setConfirming(true)}>Cancel plan</Button>;
  return (
    <form action={action} className="space-y-3 rounded-lg border border-line bg-canvas p-4">
      <p className="text-sm text-ink">Cancel your plan? It stops on {endsOn}. Credits you already have stay usable until they expire. You can start a plan again any time.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton variant="danger" pendingText="Cancelling…">Yes, cancel plan</SubmitButton>
        <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>Keep my plan</Button>
      </div>
      <FormAlert state={state} />
    </form>
  );
}
