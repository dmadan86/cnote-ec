// Responsive derivatives for approved listing images. Originals stay in the PRIVATE bucket forever; only approved
// images get derivatives, written to the PUBLIC bucket (CDN). Rejection, alt-text re-review and deletion remove them.
import { emit, getJobQueue } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { getMediaStore, getPublicMediaStore, processImage, VARIANT_MIME, type VariantFormat } from "@cnote/media";
import { bustListingCaches } from "./cache";

declare module "@cnote/core" {
  interface JobTopics {
    /** Generate AVIF/WebP/JPEG variants + blur placeholder for an approved ListingImage. Idempotent. */
    "media.process_image": { imageId: string };
  }
}

/** Shape persisted in ListingImage.variants. URLs are derived from `key` at read time so a CDN change is config only. */
export interface StoredVariant {
  width: number;
  height: number;
  format: VariantFormat;
  key: string;
  bytes: number;
}

/** Buyer-facing image. `src`/`srcSet` are the JPEG fallback; `sources` carries the AVIF/WebP <source> sets. */
export interface PublicListingImage {
  id: string;
  src: string;
  srcSet: string;
  width: number;
  height: number;
  blurDataUrl: string | null;
  alt: string;
  sources: { type: string; srcSet: string }[];
}

const route = (id: string) => `/media/listing-images/${id}`;
const FORMAT_ORDER: VariantFormat[] = ["avif", "webp", "jpeg"];

export function parseVariants(json: unknown): StoredVariant[] {
  if (!Array.isArray(json)) return [];
  return json.filter((v): v is StoredVariant => !!v && typeof v === "object" && typeof (v as StoredVariant).key === "string" && typeof (v as StoredVariant).width === "number");
}

type PublicRow = { id: string; width: number | null; height: number | null; altText: string | null; variants: unknown; blurDataUrl: string | null; processedAt: Date | null };

/** Pure mapping of an already-loaded (approved, non-deleted) row; falls back to the /media route until processed. */
export function toPublicImage(r: PublicRow): PublicListingImage {
  const store = getPublicMediaStore();
  const variants = r.processedAt ? parseVariants(r.variants) : [];
  const url = (v: StoredVariant) => store.publicUrl(v.key);
  const set = (fmt: VariantFormat) => {
    const vs = variants.filter((v) => v.format === fmt).sort((a, b) => a.width - b.width);
    const parts = vs.map((v) => [url(v), v.width] as const);
    return parts.length && parts.every(([u]) => u) ? parts.map(([u, w]) => `${u} ${w}w`).join(", ") : "";
  };
  const jpegSet = set("jpeg");
  if (!jpegSet) return { id: r.id, src: route(r.id), srcSet: "", width: r.width ?? 0, height: r.height ?? 0, blurDataUrl: r.blurDataUrl, alt: r.altText ?? "", sources: [] };
  const jpegs = variants.filter((v) => v.format === "jpeg").sort((a, b) => a.width - b.width);
  const pick = [...jpegs].reverse().find((v) => v.width <= 960) ?? jpegs[0]!;
  const biggest = jpegs[jpegs.length - 1]!;
  return {
    id: r.id,
    src: url(pick)!,
    srcSet: jpegSet,
    width: biggest.width,
    height: biggest.height,
    blurDataUrl: r.blurDataUrl,
    alt: r.altText ?? "",
    sources: FORMAT_ORDER.filter((f) => f !== "jpeg").map((f) => ({ type: VARIANT_MIME[f], srcSet: set(f) })).filter((s) => s.srcSet),
  };
}

const publicWhere = (listingIds: string[]): Prisma.ListingImageWhereInput => ({ listingId: { in: listingIds }, status: "approved", deletedAt: null });

/**
 * Approved images of a listing, in seller order. Does NOT check listing visibility: callers (public mappers) must
 * already have gated on listing published + approved. Cheap enough to batch: see publicImagesForListings.
 */
export async function publicImagesForListing(listingId: string): Promise<PublicListingImage[]> {
  return (await publicImagesForListings([listingId])).get(listingId) ?? [];
}

export async function publicImagesForListings(listingIds: string[]): Promise<Map<string, PublicListingImage[]>> {
  const out = new Map<string, PublicListingImage[]>();
  if (!listingIds.length) return out;
  const rows = await prisma.listingImage.findMany({ where: publicWhere(listingIds), orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  for (const r of rows) (out.get(r.listingId) ?? out.set(r.listingId, []).get(r.listingId)!).push(toPublicImage(r));
  return out;
}

/** Best-effort: a failed enqueue is healed by the backfill (`images:backfill`), never blocks moderation. */
export async function enqueueImageProcessing(imageId: string): Promise<void> {
  try {
    await getJobQueue().enqueue("media.process_image", { imageId });
  } catch (e) {
    console.error("[catalogue] enqueue media.process_image failed", imageId, e);
  }
}

/** Delete public derivatives and clear the columns. Safe to call repeatedly. */
export async function removePublicVariants(row: { id: string; variants: unknown }, opts: { clearRow?: boolean } = {}): Promise<void> {
  const store = getPublicMediaStore();
  for (const v of parseVariants(row.variants)) await store.delete(v.key).catch((e) => console.error("[catalogue] variant delete failed", v.key, e));
  if (opts.clearRow !== false) await prisma.listingImage.updateMany({ where: { id: row.id }, data: { variants: [], blurDataUrl: null, processedAt: null } });
}

export type ProcessResult = "processed" | "skipped" | "missing_original";

/** "media.process_image" handler. Skips images that are no longer approved (moderation may have flipped meanwhile). */
export async function processListingImage(imageId: string): Promise<ProcessResult> {
  const img = await prisma.listingImage.findUnique({ where: { id: imageId } });
  if (!img || img.deletedAt || img.status !== "approved") return "skipped";
  const original = await getMediaStore().get(img.storageKey);
  if (!original) return "missing_original";
  const out = await processImage(original.bytes, { listingId: img.listingId, imageId: img.id });
  const pub = getPublicMediaStore();
  const written: string[] = [];
  try {
    for (const v of out.variants) {
      await pub.put(v.key, v.data, v.contentType);
      written.push(v.key);
    }
    const stored: StoredVariant[] = out.variants.map((v) => ({ width: v.width, height: v.height, format: v.format, key: v.key, bytes: v.bytes }));
    await prisma.$transaction(async (tx) => {
      // Only publish derivatives if the image is STILL approved (a concurrent reject/delete wins).
      const res = await tx.listingImage.updateMany({
        where: { id: img.id, status: "approved", deletedAt: null },
        data: { variants: stored as unknown as Prisma.InputJsonValue, blurDataUrl: out.blurDataUrl, processedAt: new Date(), width: out.width, height: out.height },
      });
      if (res.count === 0) throw new StaleImage();
      await emit(tx, "ListingImageProcessed", { type: "listing_image", id: img.id }, { imageId: img.id, listingId: img.listingId, variants: stored.length });
    });
  } catch (e) {
    await Promise.all(written.map((k) => pub.delete(k).catch(() => undefined)));
    if (e instanceof StaleImage) return "skipped";
    throw e;
  }
  await bustListingCaches(img.listingId, img.sellerBusinessId);
  return "processed";
}

class StaleImage extends Error {}

/** Enqueue processing for approved images without variants (run after enabling the pipeline, or to heal failed enqueues). */
export async function backfillImageVariants(opts: { limit?: number; inline?: boolean } = {}): Promise<{ found: number; processed: number; failed: number }> {
  const rows = await prisma.listingImage.findMany({ where: { status: "approved", deletedAt: null, processedAt: null }, orderBy: { createdAt: "asc" }, take: opts.limit ?? 500, select: { id: true } });
  let processed = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      if (opts.inline === false) await enqueueImageProcessing(r.id);
      else if ((await processListingImage(r.id)) === "processed") processed++;
    } catch (e) {
      failed++;
      console.error("[catalogue] backfill failed", r.id, e);
    }
  }
  return { found: rows.length, processed, failed };
}
