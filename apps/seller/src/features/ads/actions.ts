"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import * as ads from "@cnote/ads";
import type { ActionResult } from "@cnote/next-kit";
import { DomainError, rupeesToPaise } from "@cnote/core";
import { requireSeller } from "@/lib/auth";
import { str, strs } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { parseKeywords } from "./keywords";

export type AdsResult = ActionResult<null>;

function refresh(id?: string) {
  revalidatePath("/ads");
  if (id) revalidatePath(`/ads/${id}`);
}

function requireEnabled() {
  if (!ads.isAdsEnabled()) throw new DomainError("validation", "Advertising is coming soon. It is not switched on yet.");
}

const createSchema = z.object({
  name: z.string().trim().min(2, "Give the campaign a name."),
  dailyRupees: z.coerce.number({ message: "Enter a daily budget." }).positive("Enter a daily budget."),
  totalRupees: z.union([z.literal(""), z.coerce.number().positive()]).optional(),
  startsAt: z.string().min(1, "Choose a start date."),
  endsAt: z.string().optional(),
});

/** Creates campaign + ad group + products + keywords in one go; `intent=submit` also sends it for review. */
export async function createCampaignAction(_prev: AdsResult | null, fd: FormData): Promise<AdsResult> {
  const session = await requireSeller("/ads/new");
  const seller = session.business.id;
  const res = await run(async () => {
    requireEnabled();
    const f = createSchema.parse({ name: str(fd, "name"), dailyRupees: str(fd, "dailyRupees"), totalRupees: str(fd, "totalRupees"), startsAt: str(fd, "startsAt"), endsAt: str(fd, "endsAt") });
    const listingIds = strs(fd, "listingId");
    if (!listingIds.length) throw new DomainError("validation", "Choose at least one product to advertise.");
    const keywords = parseKeywords(str(fd, "keywords"));
    const categoryIds = strs(fd, "categoryId");
    if (!keywords.some((k) => !k.negative) && !categoryIds.length) throw new DomainError("validation", "Add at least one keyword or choose a category.");
    const camp = await ads.createCampaign(seller, {
      name: f.name,
      dailyBudgetPaise: rupeesToPaise(f.dailyRupees),
      totalBudgetPaise: f.totalRupees ? rupeesToPaise(Number(f.totalRupees)) : null,
      startsAt: new Date(`${f.startsAt}T00:00:00+05:30`),
      endsAt: f.endsAt ? new Date(`${f.endsAt}T23:59:59+05:30`) : null,
    });
    const surfaces = strs(fd, "surface").filter((s): s is "search" | "category" | "product_similar" => ["search", "category", "product_similar"].includes(s));
    const group = await ads.addAdGroup(seller, camp.id, {
      name: "Main group",
      surfaces: surfaces.length ? surfaces : ["search", "category"],
      categoryIds,
      states: strs(fd, "state"),
      pincodePrefixes: str(fd, "pincodes").split(/[\s,]+/).filter(Boolean),
    });
    for (const id of listingIds) await ads.addListingToGroup(seller, group.id, id);
    for (const k of keywords) await ads.addKeyword(seller, group.id, k);
    if (str(fd, "intent") === "submit") await ads.submitCampaign(seller, camp.id);
    logEvent("seller.ad_campaign_created", { businessId: seller, submitted: str(fd, "intent") === "submit" });
    return camp.id;
  });
  if (res.ok) {
    refresh();
    redirect(`/ads/${res.data}`);
  }
  return res;
}

async function simple(id: string, fn: (seller: string) => Promise<unknown>): Promise<AdsResult> {
  const session = await requireSeller(`/ads/${id}`);
  const res = await run(async () => {
    requireEnabled();
    await fn(session.business.id);
    return null;
  });
  if (res.ok) refresh(id);
  return res.ok ? { ok: true, data: null } : res;
}

export const submitCampaignAction = async (_p: AdsResult | null, fd: FormData) => simple(str(fd, "id"), (s) => ads.submitCampaign(s, str(fd, "id")));
export const pauseCampaignAction = async (_p: AdsResult | null, fd: FormData) => simple(str(fd, "id"), (s) => ads.pauseCampaign(s, str(fd, "id")));
export const resumeCampaignAction = async (_p: AdsResult | null, fd: FormData) => simple(str(fd, "id"), (s) => ads.resumeCampaign(s, str(fd, "id")));
export const endCampaignAction = async (_p: AdsResult | null, fd: FormData) => simple(str(fd, "id"), (s) => ads.endCampaign(s, str(fd, "id")));

export async function updateBudgetAction(_p: AdsResult | null, fd: FormData): Promise<AdsResult> {
  const id = str(fd, "id");
  return simple(id, async (s) => {
    const daily = z.coerce.number({ message: "Enter a daily budget." }).positive("Enter a daily budget.").parse(str(fd, "dailyRupees"));
    const r = await ads.updateCampaign(s, id, { dailyBudgetPaise: rupeesToPaise(daily) });
    if (r.returnedToReview) logEvent("seller.ad_budget_review", { businessId: s });
  });
}

export async function addKeywordsAction(_p: AdsResult | null, fd: FormData): Promise<AdsResult> {
  const id = str(fd, "id");
  return simple(id, async (s) => {
    const c = await ads.getCampaign(s, id);
    const group = c.adGroups[0];
    if (!group) throw new DomainError("validation", "This campaign has no ad group.");
    const kws = parseKeywords(str(fd, "keywords"));
    if (!kws.length) throw new DomainError("validation", "Enter at least one keyword.");
    for (const k of kws) await ads.addKeyword(s, group.id, k);
  });
}

export async function removeKeywordAction(_p: AdsResult | null, fd: FormData): Promise<AdsResult> {
  const id = str(fd, "id");
  return simple(id, (s) => ads.removeKeyword(s, str(fd, "keywordId")));
}
