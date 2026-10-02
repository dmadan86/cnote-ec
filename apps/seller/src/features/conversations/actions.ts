"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { rupeesToPaise } from "@cnote/core";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { numOrNull, str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { enquiry } from "@/lib/services";
import { sendQuote } from "./send-quote";

export type ConvResult = ActionResult<null>;

export async function sendMessageAction(_prev: ConvResult | null, fd: FormData): Promise<ConvResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  const t = await getTranslations("leads.conversation.errors");
  return run(async () => {
    const body = z.string().min(1, t("writeFirst")).max(2000, t("maxMessage")).parse(str(fd, "body"));
    await enquiry.sendMessage(actorOf(session), z.string().min(1).parse(conversationId), body);
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}

export async function sendQuoteAction(_prev: ConvResult | null, fd: FormData): Promise<ConvResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  return run(() => sendQuote(fd, session)); // text-only: quotes WITH attachments post to /api/quotes (2 MB action body cap)
}

/** ADR-007: one-tap "did this close?" for off-platform deals. */
export async function reportDealAction(_prev: ConvResult | null, fd: FormData): Promise<ConvResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  const t = await getTranslations("leads.conversation.errors");
  return run(async () => {
    const outcome = z.enum(["won", "lost", "pending"]).parse(str(fd, "outcome"));
    const value = numOrNull(fd, "valueRupees");
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new z.ZodError([{ code: "custom", path: ["valueRupees"], message: t("dealValue"), input: value }]);
    await enquiry.reportDeal(actorOf(session), z.string().min(1).parse(str(fd, "matchId")), outcome, outcome === "won" && value !== null ? rupeesToPaise(value) : null);
    logEvent("seller.deal_reported", { businessId: session.business.id, conversationId, outcome });
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}
