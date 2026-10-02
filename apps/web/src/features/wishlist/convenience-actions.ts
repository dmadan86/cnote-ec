"use server";
// Wishlist convenience actions: bulk quote request and public share links. Each re-checks the session (server actions are
// reachable by direct POST). Matching, credits and moderation stay in @cnote/enquiry: this only calls its public createEnquiry.
import { getListingsByIds } from "@cnote/catalogue";
import { DomainError } from "@cnote/core";
import { createEnquiry } from "@cnote/enquiry";
import { actorOf, requireBusiness, requireSession, type ActionResult } from "@cnote/next-kit";
import { createShare, getList, revokeShare } from "@cnote/wishlist";
import { clientIp } from "@cnote/security/client-ip";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { runLocalized } from "@/i18n/errors";
import { getRequestLocale } from "@/lib/request-locale";
import { enquiryRequirement, enquiryTitle, groupBySupplier, MAX_BULK_PRODUCTS, MAX_BULK_SUPPLIERS } from "./bulk";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

export interface BulkRfqResult {
  /** enquiries created, one per supplier */
  created: number;
  /** suppliers whose request could not be created (rate limit, moderation, ...) */
  failed: number;
}

/** "Request quotes for selected": one enquiry per supplier among the selected, saved, still-live products. */
export async function requestQuotesForSelectedAction(_prev: ActionResult<BulkRfqResult> | null, f: FormData): Promise<ActionResult<BulkRfqResult>> {
  const s = await requireBusiness("/wishlist");
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "convenience" });
  const listId = str(f, "listId");
  const wanted = [...new Set(f.getAll("listingId").filter((v): v is string => typeof v === "string"))];
  if (!wanted.length) return { ok: false, error: t("wishlist.selectSome") };
  if (wanted.length > MAX_BULK_PRODUCTS) return { ok: false, error: t("wishlist.tooManyProducts", { max: MAX_BULK_PRODUCTS }) };

  return runLocalized(async () => {
    // Only products that are really in THIS person's list and still live can be requested (never trust the posted ids).
    const detail = await getList(s.personId, listId);
    const saved = new Set(detail.items.filter((i) => i.listing).map((i) => i.listingId));
    const ids = wanted.filter((id) => saved.has(id));
    const listings = (await getListingsByIds(ids)).filter((l) => l.status === "published" && l.moderationStatus === "approved");
    const ordered = ids.flatMap((id) => listings.filter((l) => l.id === id));
    const groups = groupBySupplier(ordered);
    if (!groups.length) throw new DomainError("validation", t("wishlist.selectSome"));
    if (groups.length > MAX_BULK_SUPPLIERS) throw new DomainError("validation", t("wishlist.tooManySuppliers", { max: MAX_BULK_SUPPLIERS }));

    let created = 0;
    let failed = 0;
    let firstError: unknown = null;
    for (const g of groups) {
      try {
        await createEnquiry(
          actorOf(s),
          {
            title: enquiryTitle(g),
            requirement: enquiryRequirement(g),
            categorySlug: g.listings[0]!.category.slug,
            preferredListingId: g.listings[0]!.id,
            preferredSellerId: g.sellerBusinessId,
            language: s.preferredLanguage,
          },
          { buyerPhoneVerified: s.phoneVerified, ip: clientIp(await headers()) },
        );
        created++;
      } catch (err) {
        failed++;
        firstError ??= err;
      }
    }
    if (created === 0 && firstError) throw firstError;
    revalidatePath("/buyer/enquiries");
    return { created, failed };
  });
}

/** Turns the public read-only link on (idempotent) and returns it. */
export async function startShareAction(_prev: ActionResult<{ token: string }> | null, f: FormData): Promise<ActionResult<{ token: string }>> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    const share = await createShare(s.personId, str(f, "listId"));
    revalidatePath("/wishlist");
    return { token: share.token };
  });
}

/** Turns it off: the link stops working immediately. */
export async function revokeShareAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    await revokeShare(s.personId, str(f, "listId"));
    revalidatePath("/wishlist");
  });
}
