// The publisher: projects approved ListingVersions from the authoring DB into the LIVE read DB.
// Subscribed to ListingVersionReviewed(approved) (worker.ts) plus a 30s sweep for scheduled/missed versions.
// Idempotent + retry-safe: the LIVE upsert is monotonic in `version`, and a ProjectionCheckpoint (consumer, versionId)
// records completed projections. See docs/design/listing-versioning-and-live-db.md.
import * as ai from "@cnote/ai";
import { DomainError, emit, invalidateTags, softInvalidateTags, cacheTags } from "@cnote/core";
import { prisma } from "@cnote/db";
import { bustSellerCaches, getTrustProfiles } from "@cnote/identity";
import { liveDb, toVectorLiteral } from "@cnote/live-db";
import { bustListingCaches } from "./cache";
import { getCategoryById } from "./categories";
import { toPublicImage } from "./image-variants";
import { isUuid, type LiveImage } from "./mappers";
import { parseSnapshot, type VersionSnapshot } from "./versions";
import { canonicalText } from "./validate";

const PUBLISHER = "publisher";
const BATCH = 100;

export type PublishOutcome = "published" | "not_due" | "skipped";

interface SellerSnap {
  name: string;
  city: string | null;
  state: string | null;
  tier: number;
  trustScore: number;
  badgeActive: boolean;
}

export interface Projection {
  listingId: string;
  versionId: string;
  version: number;
  sellerBusinessId: string;
  snap: VersionSnapshot;
  category: { id: string; slug: string; name: string };
  images: LiveImage[];
  seller: SellerSnap;
  aiGenerated: boolean;
  embedding: number[];
  embeddingVersion: string;
  publishedAt: Date;
}

async function sellerSnap(businessId: string): Promise<SellerSnap> {
  await bustSellerCaches(businessId).catch(() => {}); // trust changes must not be read from a stale cache
  const p = (await getTrustProfiles([businessId])).get(businessId);
  return { name: p?.name ?? "Seller", city: p?.city ?? null, state: p?.state ?? null, tier: p?.verificationTier ?? 0, trustScore: p?.trustScore ?? 0, badgeActive: p?.badgeActive ?? false };
}

/** Public image data for the snapshot's image ids: only images that are still approved and not deleted, in snapshot order. */
export async function projectImages(listingId: string, snap: Pick<VersionSnapshot, "imageIds" | "imageUrls">): Promise<LiveImage[]> {
  if (!snap.imageIds.length) return snap.imageUrls.map((src) => ({ id: null, src, srcSet: "", width: 0, height: 0, blurDataUrl: null, alt: "", sources: [] }));
  const rows = await prisma.listingImage.findMany({ where: { listingId, id: { in: snap.imageIds }, status: "approved", deletedAt: null } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return snap.imageIds.flatMap((id) => {
    const r = byId.get(id);
    return r ? [toPublicImage(r)] : [];
  });
}

async function embedSnapshot(snap: VersionSnapshot): Promise<{ embedding: number[]; version: string }> {
  const { vectors, version } = await ai.embed([canonicalText(snap, snap.categoryName)]);
  const embedding = vectors[0];
  if (!embedding) throw new Error("embedding provider returned no vector");
  return { embedding, version };
}

/** Writes one projection to LIVE. Monotonic (never replaces a newer version) and safe to repeat. */
export async function writeLive(p: Projection): Promise<void> {
  const attrs = JSON.stringify(p.snap.attributes);
  const images = JSON.stringify(p.images);
  const price = p.snap.pricePaise === null ? null : BigInt(p.snap.pricePaise);
  await liveDb.$transaction(async (tx) => {
    await tx.liveCategory.upsert({ where: { id: p.category.id }, create: p.category, update: { slug: p.category.slug, name: p.category.name } });
    await tx.$executeRaw`
      INSERT INTO live_listings (
        id, version_id, version, seller_business_id, category_id, category_slug, category_name, title, description, attributes,
        price_paise, price_unit, moq, moq_unit, hsn, language, ai_generated, images,
        seller_name, seller_city, seller_state, seller_tier, seller_trust_score, seller_badge_active,
        embedding, embedding_version, first_published_at, published_at, updated_at)
      VALUES (
        ${p.listingId}::uuid, ${p.versionId}::uuid, ${p.version}, ${p.sellerBusinessId}::uuid, ${p.category.id}::uuid, ${p.category.slug}, ${p.category.name},
        ${p.snap.title}, ${p.snap.description}, ${attrs}::jsonb,
        ${price}, ${p.snap.priceUnit}, ${p.snap.moq}, ${p.snap.moqUnit}, ${p.snap.hsn}, ${p.snap.language}, ${p.aiGenerated}, ${images}::jsonb,
        ${p.seller.name}, ${p.seller.city}, ${p.seller.state}, ${p.seller.tier}, ${p.seller.trustScore}, ${p.seller.badgeActive},
        ${toVectorLiteral(p.embedding)}::vector, ${p.embeddingVersion}, ${p.publishedAt}, ${p.publishedAt}, now())
      ON CONFLICT (id) DO UPDATE SET
        version_id = EXCLUDED.version_id, version = EXCLUDED.version, seller_business_id = EXCLUDED.seller_business_id,
        category_id = EXCLUDED.category_id, category_slug = EXCLUDED.category_slug, category_name = EXCLUDED.category_name,
        title = EXCLUDED.title, description = EXCLUDED.description, attributes = EXCLUDED.attributes,
        price_paise = EXCLUDED.price_paise, price_unit = EXCLUDED.price_unit, moq = EXCLUDED.moq, moq_unit = EXCLUDED.moq_unit,
        hsn = EXCLUDED.hsn, language = EXCLUDED.language, ai_generated = EXCLUDED.ai_generated, images = EXCLUDED.images,
        seller_name = EXCLUDED.seller_name, seller_city = EXCLUDED.seller_city, seller_state = EXCLUDED.seller_state,
        seller_tier = EXCLUDED.seller_tier, seller_trust_score = EXCLUDED.seller_trust_score, seller_badge_active = EXCLUDED.seller_badge_active,
        embedding = EXCLUDED.embedding, embedding_version = EXCLUDED.embedding_version, published_at = EXCLUDED.published_at, updated_at = now()
      WHERE live_listings.version <= EXCLUDED.version`;
    await tx.projectionCheckpoint.upsert({
      where: { consumer_key: { consumer: PUBLISHER, key: p.versionId } },
      create: { consumer: PUBLISHER, key: p.versionId },
      update: { appliedAt: new Date() },
    });
  });
}

/** Removes a listing from LIVE. Idempotent. */
export async function removeFromLive(listingId: string): Promise<void> {
  await liveDb.liveListing.deleteMany({ where: { id: listingId } });
}

async function buildProjection(versionId: string, publishedAt: Date): Promise<Projection | null> {
  const v = await prisma.listingVersion.findUnique({ where: { id: versionId }, include: { listing: true } });
  if (!v) return null;
  const snap = parseSnapshot(v.snapshot);
  const category = await getCategoryById(snap.categoryId);
  if (!category) throw new DomainError("validation", "Category no longer exists");
  const [images, seller, emb] = await Promise.all([projectImages(v.listingId, snap), sellerSnap(v.listing.sellerBusinessId), embedSnapshot({ ...snap, categoryName: category.name })]);
  return {
    listingId: v.listingId,
    versionId: v.id,
    version: v.version,
    sellerBusinessId: v.listing.sellerBusinessId,
    snap: { ...snap, categoryName: category.name },
    category: { id: category.id, slug: category.slug, name: category.name },
    images,
    seller,
    aiGenerated: v.listing.aiGenerated,
    embedding: emb.embedding,
    embeddingVersion: emb.version,
    publishedAt,
  };
}

/**
 * Publishes one approved version: LIVE upsert, then (authoring tx) version → published, previous → superseded,
 * Listing.liveVersionId + status, ListingVersionPublished. Safe to call repeatedly and concurrently.
 */
export async function publishVersion(versionId: string, now = new Date()): Promise<PublishOutcome> {
  if (!isUuid(versionId)) return "skipped";
  const v = await prisma.listingVersion.findUnique({ where: { id: versionId }, include: { listing: true } });
  if (!v || v.status !== "approved") return "skipped";
  if (v.publishAt && v.publishAt > now) return "not_due";
  const { listing } = v;
  if (listing.status === "archived") {
    await prisma.listingVersion.updateMany({ where: { id: v.id, status: "approved" }, data: { status: "withdrawn", reviewNote: "Listing archived" } });
    return "skipped";
  }
  const newer = await prisma.listingVersion.findFirst({ where: { listingId: v.listingId, version: { gt: v.version }, status: { in: ["published", "superseded"] } }, select: { id: true } });
  if (newer) {
    await prisma.listingVersion.updateMany({ where: { id: v.id, status: "approved" }, data: { status: "superseded", reviewNote: "A newer version is already live" } });
    return "skipped";
  }

  const proj = await buildProjection(v.id, now);
  if (!proj) return "skipped";

  const outcome = await prisma.$transaction(async (tx) => {
    // one publisher wins; a concurrent worker skips instead of double-emitting
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM listing_versions WHERE id = ${v.id}::uuid AND status = 'approved' FOR UPDATE SKIP LOCKED`;
    if (!locked.length) return "skipped" as const;
    const fresh = await tx.listing.findUniqueOrThrow({ where: { id: v.listingId }, select: { status: true, liveVersionId: true } });
    if (fresh.status === "archived") return "skipped" as const;
    await writeLive(proj); // LIVE commit first: if the authoring commit below fails, a retry re-projects the same version
    const previous = fresh.liveVersionId && fresh.liveVersionId !== v.id ? fresh.liveVersionId : null;
    if (previous) await tx.listingVersion.update({ where: { id: previous }, data: { status: "superseded" } });
    await tx.listingVersion.update({ where: { id: v.id }, data: { status: "published", publishedAt: now } });
    await tx.listing.update({ where: { id: v.listingId }, data: { liveVersionId: v.id, status: "published", moderationStatus: "approved", moderationReason: null } });
    const base = { listingId: v.listingId, sellerBusinessId: listing.sellerBusinessId };
    await emit(tx, "ListingVersionPublished", { type: "listing", id: v.listingId }, { ...base, versionId: v.id, version: v.version, previousVersionId: previous });
    if (!fresh.liveVersionId) await emit(tx, "ListingPublished", { type: "listing", id: v.listingId }, { ...base, categoryId: proj.category.id });
    return "published" as const;
  }, { timeout: 30_000, maxWait: 10_000 });

  if (outcome === "published") await bustListingCaches(v.listingId, listing.sellerBusinessId);
  return outcome;
}

/** Publisher sweep (every 30s): approved versions whose publishAt has passed (or is unset). Returns how many went live. */
export async function publishDueVersions(now = new Date(), limit = BATCH): Promise<number> {
  const due = await prisma.listingVersion.findMany({
    where: { status: "approved", OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
    orderBy: [{ listingId: "asc" }, { version: "asc" }],
    select: { id: true },
    take: limit,
  });
  let n = 0;
  for (const d of due) {
    try {
      if ((await publishVersion(d.id, now)) === "published") n++;
    } catch (e) {
      console.error("[catalogue] publish failed (will retry)", d.id, e);
    }
  }
  return n;
}

/** Takes a listing off LIVE (LIVE first, so a failure can only leave it hidden, never wrongly visible). */
export async function unpublishFromLive(listingId: string, sellerBusinessId: string, reason: string, opts: { status: "draft" | "archived" }): Promise<boolean> {
  const cur = await prisma.listing.findUnique({ where: { id: listingId }, select: { liveVersionId: true } });
  await removeFromLive(listingId);
  const wasLive = !!cur?.liveVersionId;
  await prisma.$transaction(async (tx) => {
    await tx.listingVersion.updateMany({ where: { listingId, status: { in: ["submitted", "in_review", "approved"] } }, data: { status: "withdrawn", reviewNote: `Listing ${opts.status === "archived" ? "archived" : "unpublished"}` } });
    if (cur?.liveVersionId) await tx.listingVersion.update({ where: { id: cur.liveVersionId }, data: { status: "superseded" } });
    await tx.listing.update({ where: { id: listingId }, data: { status: opts.status, liveVersionId: null, ...(opts.status === "draft" ? { moderationStatus: "pending", moderationReason: null } : {}) } });
    if (wasLive) await emit(tx, "ListingUnpublished", { type: "listing", id: listingId }, { listingId, sellerBusinessId, reason });
    if (opts.status === "archived") await emit(tx, "ListingArchived", { type: "listing", id: listingId }, { listingId, sellerBusinessId });
  });
  await bustListingCaches(listingId, sellerBusinessId);
  return wasLive;
}

// --------------------------------------------------------------------------------------------- re-projection

async function bustMany(listingIds: string[], sellerBusinessId?: string) {
  await invalidateTags([...listingIds.map(cacheTags.listing), ...(sellerBusinessId ? [cacheTags.sellerListings(sellerBusinessId)] : []), cacheTags.sitemap]);
  await softInvalidateTags([cacheTags.featured, cacheTags.search]);
}

/** TrustScoreChanged / BusinessVerified / profile edits: refresh the seller snapshot on every live listing of the seller. */
export async function reprojectSeller(businessId: string): Promise<number> {
  if (!isUuid(businessId)) return 0;
  const s = await sellerSnap(businessId);
  const rows = await liveDb.$queryRaw<{ id: string }[]>`
    UPDATE live_listings SET seller_name = ${s.name}, seller_city = ${s.city}, seller_state = ${s.state}, seller_tier = ${s.tier},
      seller_trust_score = ${s.trustScore}, seller_badge_active = ${s.badgeActive}, updated_at = now()
    WHERE seller_business_id = ${businessId}::uuid
      AND (seller_name, seller_city, seller_state, seller_tier, seller_trust_score, seller_badge_active) IS DISTINCT FROM (${s.name}, ${s.city}, ${s.state}, ${s.tier}, ${s.trustScore}, ${s.badgeActive})
    RETURNING id`;
  if (rows.length) await bustMany(rows.map((r) => r.id), businessId);
  return rows.length;
}

/** ListingImageProcessed / ListingImageModerated: rebuild the public image data of a live listing from its live snapshot. */
export async function reprojectImages(listingId: string): Promise<boolean> {
  if (!isUuid(listingId)) return false;
  const l = await prisma.listing.findUnique({ where: { id: listingId }, select: { liveVersionId: true, sellerBusinessId: true } });
  if (!l?.liveVersionId) return false;
  const v = await prisma.listingVersion.findUnique({ where: { id: l.liveVersionId }, select: { snapshot: true } });
  if (!v) return false;
  const images = await projectImages(listingId, parseSnapshot(v.snapshot));
  const json = JSON.stringify(images);
  const n = await liveDb.$executeRaw`UPDATE live_listings SET images = ${json}::jsonb, updated_at = now() WHERE id = ${listingId}::uuid AND images IS DISTINCT FROM ${json}::jsonb`;
  if (n) await bustMany([listingId], l.sellerBusinessId);
  return n > 0;
}

/**
 * Hourly self-heal (LIVE is a projection, so it can always be rebuilt from authoring):
 * - live rows whose listing is no longer published/at that version → deleted
 * - listings that claim a live version but have no LIVE row → re-projected
 * - seller snapshot + image data refreshed
 */
export async function reconcileLive(): Promise<{ removed: number; restored: number; refreshed: number }> {
  let removed = 0;
  let restored = 0;
  let refreshed = 0;
  const liveRows = await liveDb.liveListing.findMany({ select: { id: true, versionId: true, sellerBusinessId: true }, take: 5000, orderBy: { id: "asc" } });
  const auth = await prisma.listing.findMany({ where: { id: { in: liveRows.map((r) => r.id) } }, select: { id: true, status: true, liveVersionId: true } });
  const authById = new Map(auth.map((a) => [a.id, a]));
  for (const r of liveRows) {
    const a = authById.get(r.id);
    if (!a || a.status !== "published" || a.liveVersionId !== r.versionId) {
      // never delete on a version mismatch alone if authoring is *newer* than LIVE (publisher will catch up on retry)
      if (a && a.status === "published" && a.liveVersionId) continue;
      await removeFromLive(r.id);
      await bustListingCaches(r.id, r.sellerBusinessId);
      removed++;
    }
  }
  const liveIds = new Set(liveRows.map((r) => r.id));
  const claimed = await prisma.listing.findMany({ where: { status: "published", liveVersionId: { not: null } }, select: { id: true, liveVersionId: true, sellerBusinessId: true }, take: 5000 });
  for (const c of claimed) {
    const missing = !liveIds.has(c.id);
    const stale = !missing && liveRows.find((r) => r.id === c.id)?.versionId !== c.liveVersionId;
    if (!missing && !stale) continue;
    try {
      const proj = await buildProjection(c.liveVersionId!, new Date());
      if (proj) {
        await writeLive(proj);
        await bustListingCaches(c.id, c.sellerBusinessId);
        restored++;
      }
    } catch (e) {
      console.error("[catalogue] live restore failed", c.id, e);
    }
  }
  for (const sellerId of new Set(liveRows.map((r) => r.sellerBusinessId))) refreshed += await reprojectSeller(sellerId);
  for (const r of liveRows) if (await reprojectImages(r.id)) refreshed++;
  return { removed, restored, refreshed };
}

// --------------------------------------------------------------------------------------------- backfill

/**
 * Seeds LIVE from listings that are already published + approved in authoring (created before versioning existed):
 * each gets version 1 (status published) from its working copy and is projected. Idempotent (skips listings that
 * already have a live version). `listingIds` limits the scope (tests).
 */
export async function backfillLiveListings(opts: { listingIds?: string[] } = {}): Promise<{ projected: number; skipped: number }> {
  let projected = 0;
  let skipped = 0;
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await prisma.listing.findMany({
      where: { status: "published", moderationStatus: "approved", liveVersionId: null, id: opts.listingIds ? { in: opts.listingIds.filter(isUuid) } : { gt: cursor } },
      orderBy: { id: "asc" },
      take: 50,
      include: { images: { where: { status: "approved", deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } } },
    });
    if (!rows.length) break;
    for (const l of rows) {
      const category = await getCategoryById(l.categoryId);
      if (!category || category.prohibited) {
        skipped++;
        continue;
      }
      const snap: VersionSnapshot = {
        title: l.title,
        description: l.description,
        categoryId: l.categoryId,
        categoryName: category.name,
        attributes: (l.attributes && typeof l.attributes === "object" && !Array.isArray(l.attributes) ? l.attributes : {}) as Record<string, string | number>,
        pricePaise: l.pricePaise === null ? null : Number(l.pricePaise),
        priceUnit: l.priceUnit,
        moq: l.moq,
        moqUnit: l.moqUnit,
        hsn: l.hsn,
        language: l.language,
        imageIds: l.images.map((i) => i.id),
        imageUrls: l.imageUrls,
      };
      const version = await prisma.listingVersion.create({
        data: { listingId: l.id, version: ((await prisma.listingVersion.aggregate({ where: { listingId: l.id }, _max: { version: true } }))._max.version ?? 0) + 1, snapshot: snap as never, changes: [], changeNote: "Initial version (backfill)", status: "approved", reviewNote: "Backfilled from published listing", reviewedAt: new Date(), createdBy: l.sellerBusinessId },
      });
      const outcome = await publishVersion(version.id);
      if (outcome === "published") projected++;
      else skipped++;
    }
    if (opts.listingIds) break;
    cursor = rows[rows.length - 1]!.id;
  }
  return { projected, skipped };
}
