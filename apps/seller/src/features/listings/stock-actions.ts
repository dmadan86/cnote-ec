"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { DomainError } from "@cnote/core";
import type { ActionResult } from "@cnote/next-kit";
import { AVAILABILITIES, categoryAxes, type Availability, type SellerVariantView } from "@cnote/catalogue";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";
import { catalogue } from "@/lib/services";
import { MAX_VARIANT_ROWS, parseVariantRows, type VariantPayload } from "./stock-form";

export type QuickStockResult = ActionResult<{ availability: Availability; leadTimeDays: number | null }>;
export type VariantsResult = ActionResult<{ message: string; variants: SellerVariantView[] }>;

const availabilitySchema = z.enum(AVAILABILITIES as unknown as [Availability, ...Availability[]]);

/** Inline status toggle in the listings table: listing-level stock only, applied at once (no review). */
export async function quickStockAction(_prev: QuickStockResult | null, fd: FormData): Promise<QuickStockResult> {
  const t = await getTranslations("stock.actions");
  const session = await requireSeller("/listings");
  return run(async () => {
    const id = z.string().min(1).parse(str(fd, "id"));
    const availability = availabilitySchema.parse(str(fd, "availability"));
    const raw = str(fd, "leadTimeDays");
    let leadTimeDays: number | undefined;
    if (raw !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 730) throw new DomainError("validation", t("leadTimeNeeded"));
      leadTimeDays = n;
    }
    const view = await catalogue.updateListingStock(session.business.id, id, { availability, ...(leadTimeDays !== undefined ? { leadTimeDays } : {}) });
    revalidatePath("/listings");
    revalidatePath(`/listings/${id}/edit`);
    return { availability: view.ownAvailability ?? availability, leadTimeDays: view.trade?.leadTimeDays ?? null };
  });
}

const payloadSchema = z.array(
  z.object({
    id: z.string().optional(),
    sku: z.string().max(80),
    axes: z.record(z.string(), z.string().max(80)),
    priceRupees: z.string().max(20),
    moq: z.string().max(12),
    tiers: z.array(z.object({ minQty: z.string().max(12), price: z.string().max(20) })).max(8),
    availability: availabilitySchema,
    qty: z.string().max(12),
    leadTime: z.string().max(5),
    imageId: z.string().max(40),
  }),
).max(MAX_VARIANT_ROWS);

async function readRows(fd: FormData, t: Awaited<ReturnType<typeof getTranslations>>): Promise<VariantPayload[]> {
  let json: unknown;
  try {
    json = JSON.parse(str(fd, "variants") || "[]");
  } catch {
    throw new DomainError("validation", t("err.parse"));
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues.some((i) => i.code === "too_big") ? t("err.tooMany", { max: MAX_VARIANT_ROWS }) : t("err.parse"));
  return parsed.data;
}

function wordErrors(errors: ReturnType<typeof parseVariantRows>["errors"], t: Awaited<ReturnType<typeof getTranslations>>): string[] {
  return errors.map((e) => (e.code === "axis" ? t("err.axis", { n: e.n, axis: e.axis ?? "" }) : t(`err.${e.code}`, { n: e.n })));
}

async function axesOf(sellerBusinessId: string, listingId: string) {
  const listing = await catalogue.getListing(listingId);
  if (!listing || listing.sellerBusinessId !== sellerBusinessId) throw new DomainError("not_found", "Listing not found");
  const category = (await catalogue.listCategories()).find((c) => c.id === listing.category.id);
  return categoryAxes(category?.attributeSchema);
}

/** Saves the whole variant set to the working copy. Structure reaches buyers on the next Submit for review; stock inside it is applied at once. */
export async function saveVariantsAction(_prev: VariantsResult | null, fd: FormData): Promise<VariantsResult> {
  const t = await getTranslations("stock.variants");
  const session = await requireSeller("/listings");
  return run(async () => {
    const listingId = z.string().min(1).parse(str(fd, "listingId"));
    const rows = await readRows(fd, t);
    const { variants, errors } = parseVariantRows(rows, await axesOf(session.business.id, listingId));
    if (errors.length) throw new DomainError("validation", wordErrors(errors, t).join(" "));
    const saved = await catalogue.setListingVariants(session.business.id, listingId, variants);
    revalidatePath("/listings");
    revalidatePath(`/listings/${listingId}/edit`);
    return { message: t("saved"), variants: saved };
  });
}

/** Stock-only update of EXISTING variants (rows with an id): instant, no review. */
export async function updateVariantStockAction(_prev: VariantsResult | null, fd: FormData): Promise<VariantsResult> {
  const t = await getTranslations("stock.variants");
  const session = await requireSeller("/listings");
  return run(async () => {
    const listingId = z.string().min(1).parse(str(fd, "listingId"));
    const rows = (await readRows(fd, t)).filter((r) => r.id);
    const { variants, errors } = parseVariantRows(rows, []);
    // axis errors are not relevant for a stock-only update; number errors are
    const bad = errors.filter((e) => e.code === "number");
    if (bad.length) throw new DomainError("validation", wordErrors(bad, t).join(" "));
    // a made-to-order variant without its own lead time may use the listing's; the catalogue decides and its message is shown if not
    await catalogue.updateListingStock(session.business.id, listingId, {
      variants: variants.map((v) => ({ id: v.id!, availability: v.availability!, availableQty: v.availableQty ?? null, leadTimeDays: v.leadTimeDays ?? null })),
    });
    revalidatePath("/listings");
    revalidatePath(`/listings/${listingId}/edit`);
    return { message: t("stockSaved"), variants: await catalogue.listingVariantsForSeller(session.business.id, listingId) };
  });
}
