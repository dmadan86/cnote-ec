"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { refundPaymentAction } from "@/app/(console)/payments/actions";

export function RefundForm({ orderId, maxRupees }: { orderId: string; maxRupees: number }) {
  return (
    <ActionForm action={refundPaymentAction} confirm="Refund this payment? The provider refund and GST credit note cannot be undone." successMessage="Refund submitted.">
      <input type="hidden" name="orderId" value={orderId} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Amount (INR, incl. GST, max {maxRupees.toFixed(2)})
          <input name="amountRupees" type="number" step="0.01" min="0.01" max={maxRupees} defaultValue={maxRupees.toFixed(2)} required className="mt-1 block h-9 w-44 rounded-lg border border-line bg-surface px-3 text-sm" />
        </label>
        <label className="min-w-64 flex-1 text-xs">Reason
          <input name="reason" required minLength={3} maxLength={300} className="mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm" />
        </label>
        <SubmitButton variant="danger" size="sm">Refund</SubmitButton>
      </div>
    </ActionForm>
  );
}
