"use server";
import { audited } from "@cnote/admin";
import { refundPayment } from "@cnote/billing";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({
  orderId: z.uuid(),
  amountRupees: z.coerce.number().positive("Enter an amount greater than zero").max(10_000_000),
  reason: z.string().trim().min(3, "Give a reason (min 3 characters)").max(300),
});

/** Refund (full or partial) via the payment provider + GST credit note. payments.refund, audited. */
export async function refundPaymentAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ orderId: fd.get("orderId"), amountRupees: fd.get("amountRupees"), reason: fd.get("reason") });
    const amountPaise = Math.round(input.amountRupees * 100);
    const ctx = await actionContext();
    await audited(
      ctx,
      "payments.refund",
      "payment.refund",
      { type: "payment_order", id: input.orderId },
      () => refundPayment(input.orderId, amountPaise, input.reason, ctx.staff.id),
      { amountPaise, reason: input.reason },
    );
  });
  if (result.ok) {
    revalidatePath("/payments");
    revalidatePath(`/payments/${fd.get("orderId")}`);
  }
  return result;
}
