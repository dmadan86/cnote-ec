import { randomUUID } from "node:crypto";
import * as ai from "@cnote/ai";
import { cachedManyTagged, cachedTagged, cacheTags, DomainError, emit } from "@cnote/core";
import { prisma, toVectorLiteral, type Prisma, type Tx } from "@cnote/db";
import { bustListingCaches } from "./cache";
import { getCategoryById, listCategories } from "./categories";
import { isUuid, listingInclude, toListingView, type ListingRow } from "./mappers";
import { assess } from "./moderation";
import { LANGS, coerceAttributes, listingInputSchema, listingPatchSchema, parseOrThrow, validateAttributes, validatePublishable } from "./validate";
import type { ListingInput, ListingView } from "./index";

async function loadOwned(sellerBusinessId: string, listingId: string): Promise<ListingRow> {
  const row = isUuid(listingId) ? await prisma.listing.findUnique({ where: { id: listingId }, include: listingInclude }) : null;
  if (!row) throw new DomainError("not_found", "Listing not found");
  if (row.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your listing");
  return row;
}

async function requireCategory(id: string) {
  const c = await getCategoryById(id);
  if (!c) throw new DomainError("validation", "Unknown category");
  return c;
}

async function writeEmbedding(tx: Tx, id: string, embedding: number[], version: string) {
  await tx.$executeRaw`UPDATE listings SET embedding = ${toVectorLiteral(embedding)}::vector, embedding_version = ${version} WHERE id = ${id}::uuid`;
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

const isLive = (l: ListingView) => l.status === "published" && l.moderationStatus === "approved";

/**
 * Cached, PUBLIC-ONLY reads for buyer surfaces (web, search, API). A listing that is not published+approved is
 * never written to the cache and is simply absent from the result, so moderation state can't leak through it.
 * Write paths hard-invalidate the `listing:<id>` tag after commit; TTL is the safety net.
 */
export async function getPublicListingsByIds(ids: string[]): Promise<ListingView[]> {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return [];
  const byId = await cachedManyTagged<ListingView>(valid, {
    prefix: "catalogue:listing:v1",
    tags: (id) => [cacheTags.listing(id)],
    ttlSeconds: 300,
    staleSeconds: 600,
    load: async (missing) => new Map((await getListingsByIds(missing)).filter(isLive).map((l) => [l.id, l])),
  });
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export async function getPublicListing(id: string): Promise<ListingView | null> {
  return (await getPublicListingsByIds([id]))[0] ?? null;
}

/** Published + approved listings of one seller (manufacturer page). Cached; invalidated by any write to the seller's listings. */
export async function listPublicSellerListings(sellerBusinessId: string): Promise<ListingView[]> {
  if (!isUuid(sellerBusinessId)) return [];
  return cachedTagged(
    `catalogue:seller-listings:v1:${sellerBusinessId}`,
    (v: ListingView[]) => [cacheTags.sellerListings(sellerBusinessId), ...v.map((l) => cacheTags.listing(l.id))],
    300,
    async () => (await listSellerListings(sellerBusinessId)).filter(isLive),
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
    `catalogue:index:v1:${offset}:${limit}`,
    [cacheTags.sitemap],
    600,
    async () => {
      const rows = await prisma.$queryRaw<{ id: string; title: string; slug: string; updated_at: Date }[]>`
        SELECT l.id, l.title, c.slug, l.updated_at FROM listings l JOIN categories c ON c.id = l.category_id
        WHERE l.status = 'published' AND l.moderation_status = 'approved' AND NOT c.prohibited
        ORDER BY l.created_at DESC, l.id LIMIT ${limit} OFFSET ${offset}`;
      return rows.map((r) => ({ id: r.id, title: r.title, categorySlug: r.slug, updatedAt: r.updated_at.toISOString() }));
    },
    { staleSeconds: 3600 },
  );
}

export async function countPublicListings(): Promise<number> {
  return cachedTagged(
    "catalogue:index-count:v1",
    [cacheTags.sitemap],
    600,
    async () => {
      const [row] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM listings l JOIN categories c ON c.id = l.category_id WHERE l.status = 'published' AND l.moderation_status = 'approved' AND NOT c.prohibited`;
      return Number(row?.n ?? 0);
    },
    { staleSeconds: 3600 },
  );
}

export async function listSellerListings(sellerBusinessId: string): Promise<ListingView[]> {
  const rows = await prisma.listing.findMany({ where: { sellerBusinessId }, include: listingInclude, orderBy: { updatedAt: "desc" } });
  return rows.map(toListingView);
}

export async function listFeaturedListings(opts: { sort: "popular" | "new"; limit: number }): Promise<ListingView[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit)));
  return cachedTagged(
    `catalogue:featured:v1:${opts.sort}:${limit}`,
    (v: ListingView[]) => [cacheTags.featured, ...v.map((l) => cacheTags.listing(l.id))],
    120,
    async () => {
      // "popular" is a placeholder until engagement events exist: complete listings (price + MOQ + image) first, then recency.
      const ids =
        opts.sort === "new"
          ? await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM listings WHERE status = 'published' AND moderation_status = 'approved' ORDER BY created_at DESC LIMIT ${limit}`
          : await prisma.$queryRaw<{ id: string }[]>`
              SELECT id FROM listings WHERE status = 'published' AND moderation_status = 'approved'
              ORDER BY (price_paise IS NOT NULL)::int + (moq IS NOT NULL)::int + (cardinality(image_urls) > 0)::int DESC, created_at DESC
              LIMIT ${limit}`;
      return (await getListingsByIds(ids.map((r) => r.id))).filter(isLive);
    },
    { staleSeconds: 600 },
  );
}

function attrsOf(v: unknown): Record<string, string | number> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string | number>) : {};
}

export async function createListing(sellerBusinessId: string, input: ListingInput): Promise<ListingView> {
  const data = parseOrThrow(listingInputSchema, input);
  const category = await requireCategory(data.categoryId);
  const row = await prisma.listing.create({
    data: {
      ...data,
      sellerBusinessId,
      attributes: coerceAttributes(category.attributeSchema, data.attributes),
      pricePaise: data.pricePaise === null ? null : BigInt(data.pricePaise),
    },
    include: listingInclude,
  });
  return toListingView(row);
}

/** Free text → editable draft (ADR-004). Never auto-published; always aiGenerated. */
export async function draftListingFromText(sellerBusinessId: string, text: string, language: string): Promise<ListingView> {
  const clean = text.trim();
  if (clean.length < 3 || clean.length > 5000) throw new DomainError("validation", "Describe your product in 3-5000 characters");
  const lang = (LANGS as readonly string[]).includes(language) ? (language as (typeof LANGS)[number]) : "en";
  const all = await listCategories();
  const usable = all.filter((c) => !c.prohibited);
  if (!usable.length) throw new DomainError("conflict", "No categories available");

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

export async function updateListing(sellerBusinessId: string, listingId: string, input: Partial<ListingInput>): Promise<ListingView> {
  const patch = parseOrThrow(listingPatchSchema, input);
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") throw new DomainError("conflict", "Archived listings cannot be edited");

  const categoryId = patch.categoryId ?? cur.categoryId;
  const category = await requireCategory(categoryId);
  const merged = {
    title: patch.title ?? cur.title,
    description: patch.description ?? cur.description,
    attributes: coerceAttributes(category.attributeSchema, patch.attributes ?? attrsOf(cur.attributes)),
  };
  const contentChanged = CONTENT_KEYS.some((k) => {
    if (patch[k] === undefined) return false;
    const next = k === "attributes" ? merged.attributes : patch[k];
    const prev = k === "attributes" ? attrsOf(cur.attributes) : cur[k];
    return JSON.stringify(next) !== JSON.stringify(prev);
  });

  const { attributes: _a, pricePaise, ...rest } = patch;
  void _a;
  const data: Prisma.ListingUncheckedUpdateInput = { ...rest, attributes: merged.attributes };
  if (pricePaise !== undefined) data.pricePaise = pricePaise === null ? null : BigInt(pricePaise);

  if (cur.status === "published" && contentChanged) {
    // Published content edits must be re-validated, re-moderated and re-embedded before going live again.
    return runPublish(cur, category, merged, data);
  }
  if (contentChanged && cur.status === "draft") {
    data.moderationStatus = "pending";
    data.moderationReason = null;
  }
  const row = await prisma.listing.update({ where: { id: cur.id }, data, include: listingInclude });
  await bustListingCaches(cur.id, cur.sellerBusinessId);
  return toListingView(row);
}

export async function publishListing(sellerBusinessId: string, listingId: string): Promise<ListingView> {
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") throw new DomainError("conflict", "Archived listings cannot be published");
  const category = await requireCategory(cur.categoryId);
  return runPublish(cur, category, { title: cur.title, description: cur.description, attributes: coerceAttributes(category.attributeSchema, attrsOf(cur.attributes)) }, {});
}

async function runPublish(
  cur: ListingRow,
  category: NonNullable<Awaited<ReturnType<typeof getCategoryById>>>,
  content: { title: string; description: string; attributes: Record<string, string | number> },
  extra: Prisma.ListingUncheckedUpdateInput,
): Promise<ListingView> {
  const problems = [...validatePublishable(content), ...validateAttributes(category.attributeSchema, content.attributes)];
  if (problems.length) throw new DomainError("validation", problems.join("; "), problems);

  const a = await assess({ id: cur.id, ...content }, category);
  const wasLive = cur.status === "published" && cur.moderationStatus === "approved";
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.listing.update({
      where: { id: cur.id },
      data: {
        ...extra,
        attributes: content.attributes,
        // rejected content never stays live: published → draft
        status: a.outcome === "rejected" ? "draft" : "published",
        moderationStatus: a.outcome,
        moderationReason: a.reason,
      },
      include: listingInclude,
    });
    if (a.outcome !== "rejected") await writeEmbedding(tx, cur.id, a.embedding, a.embeddingVersion);
    const base = { listingId: cur.id, sellerBusinessId: cur.sellerBusinessId };
    await emit(tx, "ListingModerated", { type: "listing", id: cur.id }, { ...base, status: a.outcome, ...(a.reason ? { reason: a.reason } : {}) });
    if (a.outcome === "approved" && !wasLive) await emit(tx, "ListingPublished", { type: "listing", id: cur.id }, { ...base, categoryId: updated.categoryId });
    return updated;
  });
  await bustListingCaches(cur.id, cur.sellerBusinessId);
  return toListingView(row);
}

export async function archiveListing(sellerBusinessId: string, listingId: string): Promise<void> {
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") return;
  await prisma.$transaction(async (tx) => {
    await tx.listing.update({ where: { id: cur.id }, data: { status: "archived" } });
    await emit(tx, "ListingArchived", { type: "listing", id: cur.id }, { listingId: cur.id, sellerBusinessId: cur.sellerBusinessId });
  });
  await bustListingCaches(cur.id, cur.sellerBusinessId);
}

export async function resolveListingModeration(listingId: string, outcome: "approved" | "rejected", reason?: string): Promise<void> {
  const cur = isUuid(listingId) ? await prisma.listing.findUnique({ where: { id: listingId } }) : null;
  if (!cur) throw new DomainError("not_found", "Listing not found");
  if (cur.moderationStatus !== "review") throw new DomainError("conflict", "Listing is not awaiting moderation review");
  await prisma.$transaction(async (tx) => {
    await tx.listing.update({
      where: { id: cur.id },
      data:
        outcome === "approved"
          ? { moderationStatus: "approved", moderationReason: reason ?? null }
          : { moderationStatus: "rejected", moderationReason: reason ?? "Rejected by moderator", status: "draft" },
    });
    const base = { listingId: cur.id, sellerBusinessId: cur.sellerBusinessId };
    await emit(tx, "ListingModerated", { type: "listing", id: cur.id }, { ...base, status: outcome, ...(reason ? { reason } : {}) });
    if (outcome === "approved") await emit(tx, "ListingPublished", { type: "listing", id: cur.id }, { ...base, categoryId: cur.categoryId });
  });
  await bustListingCaches(cur.id, cur.sellerBusinessId);
}
