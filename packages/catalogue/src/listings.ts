import { randomUUID } from "node:crypto";
import * as ai from "@cnote/ai";
import { cachedManyTagged, cachedTagged, cacheTags, DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { liveDb } from "@cnote/live-db";
import { bustListingCaches } from "./cache";
import { getCategoryById, listCategories } from "./categories";
import { unpublishFromLive } from "./live";
import { isUuid, listingInclude, liveToListingView, toListingView, type ListingRow } from "./mappers";
import { LANGS, coerceAttributes, listingInputSchema, listingPatchSchema, parseOrThrow } from "./validate";
import { compactTrade, parsePriceTiers, validatePriceTiers, type PriceTier, type TradeInfo } from "./tiers";
import { reviewListingVersion, submitListingVersion, stockAndVariantProblems } from "./versions";
import { validateStock } from "./availability";
import { updateListingStock } from "./stock";
import type { ListingInput, ListingView } from "./index";

async function loadOwned(sellerBusinessId: string, listingId: string): Promise<ListingRow> {
  const row = isUuid(listingId) ? await prisma.listing.findUnique({ where: { id: listingId }, include: listingInclude }) : null;
  if (!row) throw new DomainError("not_found", "Listing not found", undefined, "ads.listingNotFound");
  if (row.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your listing");
  return row;
}

async function requireCategory(id: string) {
  const c = await getCategoryById(id);
  if (!c) throw new DomainError("validation", "Unknown category", undefined, "ads.unknownCategory");
  return c;
}

export async function getListing(id: string): Promise<ListingView | null> {
  if (!isUuid(id)) return null;
  const row = await prisma.listing.findUnique({ where: { id }, include: listingInclude });
  return row ? toListingView(row) : null;
}

/** Preserves input order; missing ids are skipped. */
export async function getListingsByIds(ids: string[]): Promise<ListingView[]> {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return [];
  const rows = await prisma.listing.findMany({ where: { id: { in: valid } }, include: listingInclude });
  const byId = new Map(rows.map((r) => [r.id, toListingView(r)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Cached PUBLIC reads for buyer surfaces (web, search, API). They read the LIVE database only, which contains nothing
 * but published projections, so unpublished/pending/rejected content can never be served. The publisher purges the
 * `listing:<id>` tags on publish/unpublish; TTL is the safety net.
 */
export async function getPublicListingsByIds(ids: string[]): Promise<ListingView[]> {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return [];
  const byId = await cachedManyTagged<ListingView>(valid, {
    prefix: "catalogue:listing:v2",
    tags: (id) => [cacheTags.listing(id)],
    ttlSeconds: 300,
    staleSeconds: 600,
    load: async (missing) => new Map((await liveDb.liveListing.findMany({ where: { id: { in: missing } } })).map((r) => [r.id, liveToListingView(r)])),
  });
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export async function getPublicListing(id: string): Promise<ListingView | null> {
  return (await getPublicListingsByIds([id]))[0] ?? null;
}

/** Live listings of one seller (manufacturer page). Cached; invalidated when any of the seller's listings is (un)published. */
export async function listPublicSellerListings(sellerBusinessId: string): Promise<ListingView[]> {
  if (!isUuid(sellerBusinessId)) return [];
  return cachedTagged(
    `catalogue:seller-listings:v2:${sellerBusinessId}`,
    (v: ListingView[]) => [cacheTags.sellerListings(sellerBusinessId), ...v.map((l) => cacheTags.listing(l.id))],
    300,
    async () => (await liveDb.liveListing.findMany({ where: { sellerBusinessId }, orderBy: [{ publishedAt: "desc" }, { id: "asc" }] })).map(liveToListingView),
    { staleSeconds: 600, softTags: [cacheTags.featured] },
  );
}

export interface ListingIndexEntry {
  id: string;
  title: string;
  categorySlug: string;
  updatedAt: string;
}

/** Lightweight, stable-ordered index of live listings for sitemaps and static params. Cached 10 min (`sitemap` tag). */
export async function listPublicListingIndex(opts: { offset: number; limit: number }): Promise<ListingIndexEntry[]> {
  const offset = Math.max(0, Math.trunc(opts.offset));
  const limit = Math.max(1, Math.min(10_000, Math.trunc(opts.limit)));
  return cachedTagged(
    `catalogue:index:v2:${offset}:${limit}`,
    [cacheTags.sitemap],
    600,
    async () => {
      const rows = await liveDb.liveListing.findMany({ select: { id: true, title: true, categorySlug: true, publishedAt: true }, orderBy: [{ firstPublishedAt: "desc" }, { id: "asc" }], skip: offset, take: limit });
      return rows.map((r) => ({ id: r.id, title: r.title, categorySlug: r.categorySlug, updatedAt: r.publishedAt.toISOString() }));
    },
    { staleSeconds: 3600 },
  );
}

export async function countPublicListings(): Promise<number> {
  return cachedTagged("catalogue:index-count:v2", [cacheTags.sitemap], 600, async () => liveDb.liveListing.count(), { staleSeconds: 3600 });
}

export async function listSellerListings(sellerBusinessId: string): Promise<ListingView[]> {
  const rows = await prisma.listing.findMany({ where: { sellerBusinessId }, include: listingInclude, orderBy: { updatedAt: "desc" } });
  return rows.map(toListingView);
}

export async function listFeaturedListings(opts: { sort: "popular" | "new"; limit: number }): Promise<ListingView[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit)));
  return cachedTagged(
    `catalogue:featured:v2:${opts.sort}:${limit}`,
    (v: ListingView[]) => [cacheTags.featured, ...v.map((l) => cacheTags.listing(l.id))],
    120,
    async () => {
      // "popular" is a placeholder until engagement events exist: complete listings (price + MOQ + image) first, then recency.
      const ids =
        opts.sort === "new"
          ? await liveDb.$queryRaw<{ id: string }[]>`SELECT id FROM live_listings ORDER BY first_published_at DESC, id LIMIT ${limit}`
          : await liveDb.$queryRaw<{ id: string }[]>`
              SELECT id FROM live_listings
              ORDER BY (price_paise IS NOT NULL)::int + (moq IS NOT NULL)::int + (jsonb_array_length(images) > 0)::int DESC, first_published_at DESC, id
              LIMIT ${limit}`;
      const rows = await liveDb.liveListing.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
      const byId = new Map(rows.map((r) => [r.id, liveToListingView(r)]));
      return ids.flatMap((r) => byId.get(r.id) ?? []);
    },
    { staleSeconds: 600 },
  );
}

function attrsOf(v: unknown): Record<string, string | number> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string | number>) : {};
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

function assertTiers(tiers: readonly PriceTier[] | undefined, moq: number | null): void {
  const errs = validatePriceTiers(tiers ?? [], moq);
  if (errs.length) throw new DomainError("validation", errs.join("; "), errs);
}

/** Scalar columns for the optional trade info (absent => leave unchanged on update, defaults on create). */
function tradeColumns(t: TradeInfo | undefined): Prisma.ListingUncheckedUpdateInput {
  if (!t) return {};
  const c = compactTrade(t);
  return {
    leadTimeDays: c.leadTimeDays ?? null,
    packaging: c.packaging ?? null,
    sampleAvailable: c.sampleAvailable ?? false,
    samplePricePaise: c.samplePricePaise == null ? null : BigInt(c.samplePricePaise),
    sampleMaxQty: c.sampleMaxQty ?? null,
    sampleDispatchDays: c.sampleDispatchDays ?? null,
    sampleMinBuyerTier: c.sampleMinBuyerTier ?? null,
    supplyCapacityPerMonth: c.supplyCapacityPerMonth ?? null,
    paymentTerms: c.paymentTerms ?? null,
    certifications: c.certifications ?? [],
    unitWeightGrams: c.unitWeightGrams ?? null,
    unitLengthMm: c.unitLengthMm ?? null,
    unitWidthMm: c.unitWidthMm ?? null,
    unitHeightMm: c.unitHeightMm ?? null,
  };
}

export async function createListing(sellerBusinessId: string, input: ListingInput): Promise<ListingView> {
  const { trade, ...data } = parseOrThrow(listingInputSchema, input);
  assertTiers(data.priceTiers, data.moq);
  const stated = data.availability !== undefined || data.availableQty !== undefined;
  if (stated) {
    const errs = validateStock({ availability: data.availability ?? "in_stock", availableQty: data.availableQty, leadTimeDays: trade?.leadTimeDays }, "Stock");
    if (errs.length) throw new DomainError("validation", errs.join("; "), errs);
  }
  const category = await requireCategory(data.categoryId);
  try {
    const row = await prisma.listing.create({
      data: {
        ...data,
        ...(tradeColumns(trade) as Prisma.ListingUncheckedCreateInput),
        stockUpdatedAt: stated ? new Date() : null,
        priceTiers: data.priceTiers ?? [],
        sku: data.sku ?? null,
        sellerBusinessId,
        attributes: coerceAttributes(category.attributeSchema, data.attributes),
        pricePaise: data.pricePaise === null ? null : BigInt(data.pricePaise),
      },
      include: listingInclude,
    });
    return toListingView(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("conflict", `SKU "${data.sku}" is already used by another of your listings`, undefined, "catalogue.skuAlreadyUsedByAnother", { sku: data.sku ?? "" });
    throw e;
  }
}

/** Free text → editable draft (ADR-004). Never auto-published; always aiGenerated. */
export async function draftListingFromText(sellerBusinessId: string, text: string, language: string): Promise<ListingView> {
  const clean = text.trim();
  if (clean.length < 3 || clean.length > 5000) throw new DomainError("validation", "Describe your product in 3-5000 characters");
  const lang = (LANGS as readonly string[]).includes(language) ? (language as (typeof LANGS)[number]) : "en";
  const all = await listCategories();
  const usable = all.filter((c) => !c.prohibited);
  if (!usable.length) throw new DomainError("conflict", "No categories available", undefined, "catalogue.noCategoriesAvailable");

  const id = randomUUID(); // subject id for the AI decision log precedes the row
  const ex = await ai.extractListing(
    { text: clean, language: lang, categories: usable.map((c) => ({ slug: c.slug, name: c.name, attributeSchema: c.attributeSchema })) },
    { type: "listing", id },
  );
  const category = usable.find((c) => c.slug === ex.categorySlug) ?? usable[0]!; // seller confirms/changes in the editor
  const attrs = coerceAttributes(
    category.attributeSchema,
    Object.fromEntries(Object.entries(ex.attributes ?? {}).filter(([, v]) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))),
  );
  const int = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null);
  const row = await prisma.listing.create({
    data: {
      id,
      sellerBusinessId,
      categoryId: category.id,
      title: (ex.title?.trim() || clean).slice(0, 200),
      description: (ex.description?.trim() || clean).slice(0, 5000),
      attributes: attrs,
      pricePaise: int(ex.pricePaise) === null ? null : BigInt(int(ex.pricePaise)!),
      priceUnit: ex.priceUnit?.slice(0, 30) ?? null,
      moq: int(ex.moq) && int(ex.moq)! >= 1 ? int(ex.moq) : null,
      moqUnit: ex.moqUnit?.slice(0, 30) ?? null,
      hsn: ex.hsn && /^\d{2,8}$/.test(ex.hsn) ? ex.hsn : null,
      language: lang,
      aiGenerated: true,
    },
    include: listingInclude,
  });
  return toListingView(row);
}

const CONTENT_KEYS = ["title", "description", "attributes", "categoryId"] as const;

/**
 * Edits the seller's WORKING COPY only. Nothing here touches what buyers see: content reaches the live database only
 * through submitListingVersion → review → publisher (docs/design/listing-versioning-and-live-db.md).
 */
export async function updateListing(sellerBusinessId: string, listingId: string, input: Partial<ListingInput>): Promise<ListingView> {
  const patch = parseOrThrow(listingPatchSchema, input);
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") throw new DomainError("conflict", "Archived listings cannot be edited");

  const categoryId = patch.categoryId ?? cur.categoryId;
  const category = await requireCategory(categoryId);
  const attributes = coerceAttributes(category.attributeSchema, patch.attributes ?? attrsOf(cur.attributes));
  const contentChanged = CONTENT_KEYS.some((k) => {
    if (patch[k] === undefined) return false;
    const next = k === "attributes" ? attributes : patch[k];
    const prev = k === "attributes" ? attrsOf(cur.attributes) : cur[k];
    return JSON.stringify(next) !== JSON.stringify(prev);
  });

  const { attributes: _a, pricePaise, trade, availability: nextAvailability, availableQty: nextQty, ...rest } = patch;
  void _a;
  // stock is operational: it takes the stock fast path below (no review) and is validated against the lead time as it will be stored
  const nextLead = trade ? (trade.leadTimeDays ?? null) : cur.leadTimeDays;
  if (!cur.variants.length && (nextAvailability !== undefined || nextQty !== undefined || trade)) {
    const errs = validateStock({ availability: nextAvailability ?? cur.availability, availableQty: nextQty !== undefined ? nextQty : cur.availableQty, leadTimeDays: nextLead }, "Stock");
    if (errs.length) throw new DomainError("validation", errs.join("; "), errs);
  }
  if (patch.categoryId !== undefined && patch.categoryId !== cur.categoryId && cur.variants.length) {
    const errs = stockAndVariantProblems({ ...cur, categoryId: patch.categoryId }, category);
    if (errs.length) throw new DomainError("validation", `Variants do not fit the new category: ${errs.join("; ")}`, errs);
  }
  if (patch.priceTiers !== undefined || patch.moq !== undefined) assertTiers(patch.priceTiers ?? parsePriceTiers(cur.priceTiers), patch.moq !== undefined ? patch.moq : cur.moq);
  const data: Prisma.ListingUncheckedUpdateInput = { ...rest, attributes, ...tradeColumns(trade) };
  if (pricePaise !== undefined) data.pricePaise = pricePaise === null ? null : BigInt(pricePaise);
  if (contentChanged && cur.status === "draft" && !cur.liveVersionId) {
    data.moderationStatus = "pending";
    data.moderationReason = null;
  }
  let row;
  try {
    row = await prisma.listing.update({ where: { id: cur.id }, data, include: listingInclude });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("conflict", `SKU "${patch.sku}" is already used by another of your listings`, undefined, "catalogue.skuAlreadyUsedByAnother", { sku: patch.sku ?? "" });
    throw e;
  }
  await bustListingCaches(cur.id, cur.sellerBusinessId); // seller-facing lists; buyers are unaffected until a version is published
  if (nextAvailability !== undefined || nextQty !== undefined) {
    return updateListingStock(sellerBusinessId, cur.id, { ...(nextAvailability !== undefined ? { availability: nextAvailability } : {}), ...(nextQty !== undefined ? { availableQty: nextQty } : {}) });
  }
  return toListingView(row);
}

/**
 * Submit the working copy for review (compat wrapper over submitListingVersion). The listing is NOT live when this
 * returns: it goes live after approval, through the publisher.
 */
export async function publishListing(sellerBusinessId: string, listingId: string): Promise<ListingView> {
  await submitListingVersion(sellerBusinessId, listingId, { changeNote: null });
  const row = await prisma.listing.findUniqueOrThrow({ where: { id: listingId }, include: listingInclude });
  return toListingView(row);
}

/** Take a live listing down (back to draft). Buyers stop seeing it immediately; history is kept. */
export async function unpublishListing(sellerBusinessId: string, listingId: string): Promise<void> {
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") throw new DomainError("conflict", "Archived listings cannot be unpublished", undefined, "catalogue.archivedListingsUnpublished");
  await unpublishFromLive(cur.id, cur.sellerBusinessId, "seller_unpublished", { status: "draft" });
}

export async function archiveListing(sellerBusinessId: string, listingId: string): Promise<void> {
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") return;
  await unpublishFromLive(cur.id, cur.sellerBusinessId, "archived", { status: "archived" });
}

/**
 * Resolves a listing that is waiting in the AI/human review queue: delegates to the version review of its
 * in-review version. `staffId` is recorded as the reviewer when known.
 */
export async function resolveListingModeration(listingId: string, outcome: "approved" | "rejected", reason?: string, staffId?: string): Promise<void> {
  const cur = isUuid(listingId) ? await prisma.listing.findUnique({ where: { id: listingId } }) : null;
  if (!cur) throw new DomainError("not_found", "Listing not found", undefined, "ads.listingNotFound");
  const pending = await prisma.listingVersion.findFirst({ where: { listingId, status: "in_review" }, orderBy: { version: "desc" }, select: { id: true } });
  if (!pending) throw new DomainError("conflict", "Listing is not awaiting moderation review");
  await reviewListingVersion(pending.id, outcome, reason ?? (outcome === "rejected" ? "Rejected by moderator" : null), staffId ?? "00000000-0000-0000-0000-000000000000");
}
