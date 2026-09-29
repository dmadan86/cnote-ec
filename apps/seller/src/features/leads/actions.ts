"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { enquiry } from "@/lib/services";

export type LeadResult = ActionResult<{ conversationId: string | null } | null>;

const matchIdSchema = z.string().min(1, "Missing lead.");

function refresh() {
  revalidatePath("/leads");
  revalidatePath("/dashboard");
  revalidatePath("/billing");
}

/** ADR-002/005: accepting consumes exactly one lead credit and reveals the buyer. */
export async function acceptLeadAction(_prev: LeadResult | null, fd: FormData): Promise<LeadResult> {
  const session = await requireSeller("/leads");
  return run(async () => {
    const matchId = matchIdSchema.parse(str(fd, "matchId"));
    const lead = await enquiry.acceptLead(actorOf(session), matchId);
    logEvent("seller.lead_accepted", { businessId: session.business.id, matchId });
    refresh();
    return { conversationId: lead.conversationId };
  });
}

const DECLINE_REASONS = ["Not what I sell", "Quantity too small", "Outside my delivery area", "Budget does not match", "Too busy right now", "Other"];

export async function declineLeadAction(_prev: LeadResult | null, fd: FormData): Promise<LeadResult> {
  const session = await requireSeller("/leads");
  return run(async () => {
    const matchId = matchIdSchema.parse(str(fd, "matchId"));
    const reason = z.enum(DECLINE_REASONS as [string, ...string[]]).optional().parse(str(fd, "reason") || undefined);
    await enquiry.declineLead(actorOf(session), matchId, reason);
    logEvent("seller.lead_declined", { businessId: session.business.id, matchId, reason });
    refresh();
    return null;
  });
}

/** ADR-002: unreachable/fake within 72h is verified automatically and the credit is refunded, no ticket. */
export async function reportBuyerProblemAction(_prev: LeadResult | null, fd: FormData): Promise<LeadResult> {
  const session = await requireSeller("/leads");
  return run(async () => {
    const matchId = matchIdSchema.parse(str(fd, "matchId"));
    const kind = z.enum(["buyer_unreachable", "buyer_fake"]).parse(str(fd, "kind"));
    await enquiry.reportBuyerProblem(actorOf(session), matchId, kind);
    logEvent("seller.lead_reported", { businessId: session.business.id, matchId, kind });
    refresh();
    return null;
  });
}
