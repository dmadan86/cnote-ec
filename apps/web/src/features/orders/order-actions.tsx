"use client";
import type { OrderView } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { orderAction } from "./actions";

/** Buyer's next steps for an order. Only the actions the server says are currently allowed are rendered. */
export function OrderActions({ orderId, actions }: { orderId: string; actions: OrderView["actions"] }) {
  const t = useTranslations("buyer");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(orderAction, null);
  const moves = actions.moves.filter((m) => m !== "dispatched");
  if (!actions.confirm && moves.length === 0) return null;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {actions.confirm ? <Button type="submit" name="intent" value="confirm" disabled={pending}>{t("confirmOrder")}</Button> : null}
        {moves.map((m) => (
          <Button key={m} type="submit" name="intent" value={m} variant={m === "cancelled" ? "outline" : "primary"} disabled={pending}>
            {t(`move.${m}`)}
          </Button>
        ))}
      </div>
    </form>
  );
}
