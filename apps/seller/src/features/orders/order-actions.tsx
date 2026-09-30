"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { OrderView } from "@cnote/enquiry";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { orderAction, type OrderResult } from "./actions";

/** Seller's next steps. Only actions the server reports as currently allowed are shown. */
export function OrderActions({ orderId, actions }: { orderId: string; actions: OrderView["actions"] }) {
  const t = useTranslations("orders");
  const [state, action] = useActionState<OrderResult | null, FormData>(orderAction, null);
  const moves = actions.moves.filter((m) => m === "dispatched" || m === "cancelled");
  if (!actions.confirm && moves.length === 0) return null;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="orderId" value={orderId} />
      <FormAlert state={state} />
      <div className="flex flex-wrap gap-2">
        {actions.confirm ? <SubmitButton name="intent" value="confirm" pendingText={t("confirming")}>{t("confirm")}</SubmitButton> : null}
        {moves.includes("dispatched") ? <SubmitButton name="intent" value="dispatched" pendingText={t("saving")}>{t("dispatch")}</SubmitButton> : null}
        {moves.includes("cancelled") ? <SubmitButton name="intent" value="cancelled" variant="outline" pendingText={t("cancelling")}>{t("cancel")}</SubmitButton> : null}
      </div>
    </form>
  );
}
