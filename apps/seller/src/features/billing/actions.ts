"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { billing } from "@/lib/services";

export type BillingResult = ActionResult<null>;

function refresh() {
  revalidatePath("/billing");
  revalidatePath("/dashboard");
  revalidatePath("/leads");
}

/** ADR-005: explicit, user-initiated plan start. Never auto-upgraded. Payment is mocked in Phase 1. */
export async function subscribeAction(_prev: BillingResult | null, fd: FormData): Promise<BillingResult> {
  const session = await requireSeller("/billing");
  return run(async () => {
    const code = z.string().min(1, "Choose a plan.").parse(str(fd, "planCode"));
    await billing.subscribe(session.business.id, code);
    logEvent("seller.plan_started", { businessId: session.business.id, planCode: code });
    refresh();
    return null;
  });
}

export async function cancelPlanAction(_prev: BillingResult | null): Promise<BillingResult> {
  void _prev;
  const session = await requireSeller("/billing");
  return run(async () => {
    await billing.cancelSubscription(session.business.id);
    logEvent("seller.plan_cancelled", { businessId: session.business.id });
    refresh();
    return null;
  });
}
