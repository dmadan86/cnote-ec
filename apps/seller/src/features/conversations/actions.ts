"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { rupeesToPaise } from "@cnote/core";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { numOrNull, str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { enquiry } from "@/lib/services";

export type ConvResult = ActionResult<null>;

export async function sendMessageAction(_prev: ConvResult | null, fd: FormData): Promise<ConvResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  return run(async () => {
    const body = z.string().min(1, "Write a message first.").max(2000, "Keep messages under 2,000 characters.").parse(str(fd, "body"));
    await enquiry.sendMessage(actorOf(session), z.string().min(1).parse(conversationId), body);
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}

const quoteSchema = z.object({
  price: z.number("Enter the price in rupees.").positive("Price must be more than 0."),
  quantity: z.number("Enter the quantity.").positive("Quantity must be more than 0."),
  unit: z.string().min(1, "Choose a unit."),
  leadTimeDays: z.number().int("Use whole days.").min(0).nullable().refine((v) => v === null || Number.isFinite(v), "Enter whole days."),
  validUntil: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "Choose a valid date."),
  notes: z.string().max(1000, "Keep notes under 1,000 characters."),
});

export async function sendQuoteAction(_prev: ConvResult | null, fd: FormData): Promise<ConvResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  return run(async () => {
    const q = quoteSchema.parse({
      price: numOrNull(fd, "price") ?? undefined,
      quantity: numOrNull(fd, "quantity") ?? undefined,
      unit: str(fd, "unit"),
      leadTimeDays: numOrNull(fd, "leadTimeDays"),
      validUntil: str(fd, "validUntil"),
      notes: str(fd, "notes"),
    });
    await enquiry.sendQuote(actorOf(session), z.string().min(1).parse(conversationId), {
      pricePaise: rupeesToPaise(q.price),
      quantity: q.quantity,
      unit: q.unit,
      leadTimeDays: q.leadTimeDays,
      notes: q.notes || null,
      validUntil: q.validUntil ? new Date(`${q.validUntil}T23:59:59+05:30`).toISOString() : null,
    });
    logEvent("seller.quote_sent", { businessId: session.business.id, conversationId });
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}

/** ADR-007: one-tap "did this close?" for off-platform deals. */
export async function reportDealAction(_prev: ConvResult | null, fd: FormData): Promise<ConvResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  return run(async () => {
    const outcome = z.enum(["won", "lost", "pending"]).parse(str(fd, "outcome"));
    const value = numOrNull(fd, "valueRupees");
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new z.ZodError([{ code: "custom", path: ["valueRupees"], message: "Enter the deal value in rupees.", input: value }]);
    await enquiry.reportDeal(actorOf(session), z.string().min(1).parse(str(fd, "matchId")), outcome, outcome === "won" && value !== null ? rupeesToPaise(value) : null);
    logEvent("seller.deal_reported", { businessId: session.business.id, conversationId, outcome });
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}
