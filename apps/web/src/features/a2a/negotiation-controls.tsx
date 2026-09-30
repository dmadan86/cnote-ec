"use client";
import { Button } from "@cnote/ui";
import { negotiationAction } from "./actions";
import { ActionMessage } from "./action-message";
import type { A2aLabels } from "./labels";
import { useA2aAction } from "./use-a2a-action";

/**
 * Confirm / Decline (the buyer's own decision), retry-order and withdraw. One component, one always-mounted live region, so the outcome is
 * still announced after the buttons disappear on the refreshed page. Each button is its own form with a hidden `intent`.
 */
export function NegotiationActions({ id, canConfirm, canRetry, canWithdraw, t }: { id: string; canConfirm: boolean; canRetry: boolean; canWithdraw: boolean; t: A2aLabels }) {
  const { state, pending, onSubmit } = useA2aAction(negotiationAction);
  const one = (intent: string, label: string, variant: "accent" | "outline" | "primary") => (
    <form onSubmit={onSubmit} key={intent}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      <Button type="submit" variant={variant} disabled={pending} aria-busy={pending} className="min-h-11">{pending ? t.working : label}</Button>
    </form>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        {canConfirm ? [one("confirm", t.confirmDeal, "accent"), one("decline", t.declineDeal, "outline")] : null}
        {canRetry ? one("retry", t.retry, "primary") : null}
        {canWithdraw ? one("withdraw", t.withdraw, "outline") : null}
      </div>
      <ActionMessage state={state} t={t} />
    </div>
  );
}
