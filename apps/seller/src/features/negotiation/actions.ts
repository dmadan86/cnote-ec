"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { rupeesToPaise } from "@cnote/core";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { approveDraft, discardDraft, requestDraft, upsertPriceBookEntry } from "@cnote/negotiation";
import { requireSeller } from "@/lib/auth";
import { numOrNull, str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";

export type NegotiationResult = ActionResult<null>;

const zerr = (path: string, message: string) => new z.ZodError([{ code: "custom", path: [path], message, input: null }]);
type ErrT = Awaited<ReturnType<typeof getTranslations>>;
const rupees = (fd: FormData, key: string, label: string, t: ErrT): number => {
  const n = numOrNull(fd, key);
  if (n === null || !Number.isFinite(n) || n <= 0) throw zerr(key, t("enterRupees", { label }));
  return rupeesToPaise(n);
};

/** Price book entry for one of the seller's listings (ADR-014). The floor is private and bounds every agent-drafted price. */
export async function savePriceBookAction(_prev: NegotiationResult | null, fd: FormData): Promise<NegotiationResult> {
  const session = await requireSeller("/price-book");
  const t = await getTranslations("negotiation.errors");
  return run(async () => {
    const listingId = z.string().uuid(t("chooseListing")).parse(str(fd, "listingId"));
    const tiers: { minQty: number; pricePaise: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const q = numOrNull(fd, `tierQty${i}`), p = numOrNull(fd, `tierPrice${i}`);
      if (q === null && p === null) continue;
      if (q === null || p === null || !Number.isFinite(q) || !Number.isFinite(p) || p <= 0) throw zerr(`tierQty${i}`, t("tierBoth"));
      tiers.push({ minQty: q, pricePaise: rupeesToPaise(p) });
    }
    const moq = numOrNull(fd, "moq");
    const gst = numOrNull(fd, "gstPercent");
    await upsertPriceBookEntry(actorOf(session), listingId, {
      basePricePaise: rupees(fd, "base", t("labelBase"), t),
      unit: str(fd, "unit"),
      tiers,
      floorPricePaise: rupees(fd, "floor", t("labelFloor"), t),
      moq: moq === null ? null : Math.trunc(moq),
      leadTimeDays: Math.trunc(numOrNull(fd, "leadTimeDays") ?? NaN),
      deliveryTerms: str(fd, "deliveryTerms") || null,
      gstPercent: gst === null ? null : Math.trunc(gst),
      gstIncluded: fd.get("gstIncluded") === "on",
      validityDays: Math.trunc(numOrNull(fd, "validityDays") ?? NaN),
      active: fd.get("active") === "on",
    });
    logEvent("seller.price_book_saved", { businessId: session.business.id });
    revalidatePath("/price-book");
    return null;
  });
}

export async function requestDraftAction(_prev: NegotiationResult | null, fd: FormData): Promise<NegotiationResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  const t = await getTranslations("negotiation.errors");
  return run(async () => {
    const draft = await requestDraft(actorOf(session), z.string().min(1).parse(str(fd, "matchId")));
    if (!draft) throw zerr("matchId", t("noDraft"));
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}

/** The seller confirms (optionally with edits): this is the only thing that turns a draft into a real quote. */
export async function approveDraftAction(_prev: NegotiationResult | null, fd: FormData): Promise<NegotiationResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  const t = await getTranslations("negotiation.errors");
  return run(async () => {
    const validUntil = str(fd, "validUntil");
    const lead = numOrNull(fd, "leadTimeDays");
    await approveDraft(actorOf(session), z.string().min(1).parse(str(fd, "draftId")), {
      pricePaise: rupees(fd, "price", t("labelPrice"), t),
      quantity: Math.trunc(numOrNull(fd, "quantity") ?? NaN),
      unit: str(fd, "unit"),
      leadTimeDays: lead === null ? null : Math.trunc(lead),
      validUntil: validUntil || null,
      notes: str(fd, "notes") || null,
    });
    logEvent("seller.quote_draft_approved", { businessId: session.business.id, conversationId });
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}

export async function discardDraftAction(_prev: NegotiationResult | null, fd: FormData): Promise<NegotiationResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  return run(async () => {
    await discardDraft(actorOf(session), z.string().min(1).parse(str(fd, "draftId")));
    revalidatePath(`/conversations/${conversationId}`);
    return null;
  });
}
