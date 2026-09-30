"use client";
import type { OrderView } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button } from "@cnote/ui";
import { useActionState } from "react";
import { orderAction } from "./actions";

const MOVE_LABEL = { delivered: "Mark as delivered", completed: "Mark as completed", cancelled: "Cancel order", dispatched: "" } as const;

/** Buyer's next steps for an order. Only the actions the server says are currently allowed are rendered. */
export function OrderActions({ orderId, actions }: { orderId: string; actions: OrderView["actions"] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(orderAction, null);
  const moves = actions.moves.filter((m) => m !== "dispatched");
  if (!actions.confirm && moves.length === 0) return null;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {actions.confirm ? <Button type="submit" name="intent" value="confirm" disabled={pending}>Confirm order details</Button> : null}
        {moves.map((m) => (
          <Button key={m} type="submit" name="intent" value={m} variant={m === "cancelled" ? "outline" : "primary"} disabled={pending}>
            {MOVE_LABEL[m]}
          </Button>
        ))}
      </div>
    </form>
  );
}
