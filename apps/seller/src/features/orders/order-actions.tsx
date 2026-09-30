"use client";
import { useActionState } from "react";
import type { OrderView } from "@cnote/enquiry";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { orderAction, type OrderResult } from "./actions";

/** Seller's next steps. Only actions the server reports as currently allowed are shown. */
export function OrderActions({ orderId, actions }: { orderId: string; actions: OrderView["actions"] }) {
  const [state, action] = useActionState<OrderResult | null, FormData>(orderAction, null);
  const moves = actions.moves.filter((m) => m === "dispatched" || m === "cancelled");
  if (!actions.confirm && moves.length === 0) return null;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="orderId" value={orderId} />
      <FormAlert state={state} />
      <div className="flex flex-wrap gap-2">
        {actions.confirm ? <SubmitButton name="intent" value="confirm" pendingText="Confirming…">Confirm order details</SubmitButton> : null}
        {moves.includes("dispatched") ? <SubmitButton name="intent" value="dispatched" pendingText="Saving…">Mark as dispatched</SubmitButton> : null}
        {moves.includes("cancelled") ? <SubmitButton name="intent" value="cancelled" variant="outline" pendingText="Cancelling…">Cancel order</SubmitButton> : null}
      </div>
    </form>
  );
}
