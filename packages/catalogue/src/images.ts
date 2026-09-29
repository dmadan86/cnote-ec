// Seller-uploaded listing images with mandatory staff approval (ADR-003, ADR-004, ADR-008).
// Every image starts `pending` (or `flagged` after the AI pre-screen) and is invisible to buyers until a
// staff member approves it. The AI pre-screen only ever escalates; it never approves.
// FUTURE (ADR-004): run a vision-language check on the pixels; today only altText/filename are screened.
import { randomUUID } from "node:crypto";
import * as ai from "@cnote/ai";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { bustListingCaches } from "./cache";
import { ImageValidationError, getMediaStore, getPublicMediaStore, listingImageKey, validateImage, type ImageMime } from "@cnote/media";
import { enqueueImageProcessing, parseVariants, removePublicVariants } from "./image-variants";
import { getListing } from "./listings";
import { isUuid } from "./mappers";
import type { ListingView } from "./index";

export const MAX_IMAGES_PER_LISTING = 8;
export const UPLOADS_PER_HOUR = 60;
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ALT_MAX = 200;

export type ImageStatus = "pending" | "flagged" | "approved" | "rejected";

/** Same path is mounted in web (public/approved), seller (own) and admin (staff) apps. */
export const listingImageUrl = (id: string) => `/media/listing-images/${id}`;

export interface ListingImageView {
  id: string;
  url: string;
  status: ImageStatus;
  moderationNote: string | null;
  altText: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  sortOrder: number;
  createdAt: string;
}

export interface ImageModerationItem extends ListingImageView {
  listingId: string;
  listingTitle: string;
  sellerBusinessId: string;
  sellerName: string;
  aiVerdict: string | null;
  mimeType: string;
}

type ImageRow = Prisma.ListingImageGetPayload<object>;

const toView = (r: ImageRow): ListingImageView => ({
  id: r.id,
  url: listingImageUrl(r.id),
  status: r.status,
  moderationNote: r.moderationNote,
  altText: r.altText,
  width: r.width,
  height: r.height,
  bytes: r.bytes,
  sortOrder: r.sortOrder,
  createdAt: r.createdAt.toISOString(),
});

async function loadOwnedListing(sellerBusinessId: string, listingId: string) {
  const l = isUuid(listingId) ? await prisma.listing.findUnique({ where: { id: listingId } }) : null;
  if (!l) throw new DomainError("not_found", "Listing not found");
  if (l.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your listing");
  return l;
}

async function loadOwnedImage(sellerBusinessId: string, imageId: string) {
  const img = isUuid(imageId) ? await prisma.listingImage.findUnique({ where: { id: imageId } }) : null;
  if (!img || img.deletedAt) throw new DomainError("not_found", "Image not found");
  if (img.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your image");
  return img;
}

const cleanAlt = (s: string | null | undefined) => {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, ALT_MAX) : null;
};

/** Text-only AI pre-screen. Returns the verdict string stored on the row; block/review → flagged. */
async function prescreen(listingId: string, listingTitle: string, altText: string | null, filename: string | undefined): Promise<{ verdict: string | null; flagged: boolean }> {
  const text = [listingTitle, altText, filename ? filename.slice(0, 120) : null].filter(Boolean).join("\n");
  const m = await ai.moderate({ text }, { type: "listing", id: listingId }).catch(() => null);
  if (!m) return { verdict: "unavailable", flagged: true }; // fail closed: a human looks at it anyway
  const flagged = m.verdict !== "allow" || m.needsReview;
  return { verdict: m.reason ? `${m.verdict}: ${m.reason}`.slice(0, 300) : m.verdict, flagged };
}

export async function uploadListingImage(
  sellerBusinessId: string,
  listingId: string,
  input: { bytes: Uint8Array; filename?: string; altText?: string | null },
  /** bulk import raises the hourly cap (still bounded); every image still goes through staff approval */
  opts: { rateLimitPerHour?: number } = {},
): Promise<ListingImageView> {
  const listing = await loadOwnedListing(sellerBusinessId, listingId);
  if (listing.status === "archived") throw new DomainError("conflict", "Archived listings cannot be edited");

  let v;
  try {
    v = validateImage(input.bytes);
  } catch (e) {
    if (e instanceof ImageValidationError) throw new DomainError("validation", e.message);
    throw e;
  }

  // Dedupe per listing. A previously rejected copy (even if the seller deleted it) blocks re-upload.
  const dupes = await prisma.listingImage.findMany({ where: { listingId: listing.id, sha256: v.sha256, OR: [{ deletedAt: null }, { status: "rejected" }] } });
  const rejected = dupes.find((d) => d.status === "rejected");
  if (rejected) throw new DomainError("validation", `This image was already rejected${rejected.moderationNote ? `: ${rejected.moderationNote}` : ""}`);
  if (dupes.length) throw new DomainError("conflict", "This image is already uploaded for this listing");

  const live = await prisma.listingImage.count({ where: { listingId: listing.id, deletedAt: null } });
  if (live >= MAX_IMAGES_PER_LISTING) throw new DomainError("conflict", `A listing can have at most ${MAX_IMAGES_PER_LISTING} images`);

  if (!(await rateLimit(`listing-image-upload${opts.rateLimitPerHour ? "-bulk" : ""}:${sellerBusinessId}`, opts.rateLimitPerHour ?? UPLOADS_PER_HOUR, 3600))) {
    throw new DomainError("rate_limited", "Too many uploads. Please try again in a while.");
  }

  const altText = cleanAlt(input.altText);
  const screen = await prescreen(listing.id, listing.title, altText, input.filename);

  const id = randomUUID();
  const key = listingImageKey(listing.id, id, v.ext);
  const store = getMediaStore();
  await store.put(key, input.bytes, v.mime);
  try {
    const last = await prisma.listingImage.aggregate({ where: { listingId: listing.id, deletedAt: null }, _max: { sortOrder: true } });
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.listingImage.create({
        data: {
          id,
          listingId: listing.id,
          sellerBusinessId,
          storageKey: key,
          mimeType: v.mime,
          bytes: v.bytes,
          width: v.width,
          height: v.height,
          sha256: v.sha256,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
          altText,
          status: screen.flagged ? "flagged" : "pending", // never auto-approved
          aiVerdict: screen.verdict,
        },
      });
      await emit(tx, "ListingImageUploaded", { type: "listing_image", id }, { imageId: id, listingId: listing.id, sellerBusinessId, aiVerdict: screen.verdict });
      return created;
    });
    return toView(row);
  } catch (e) {
    await store.delete(key).catch(() => undefined);
    throw e;
  }
}

export async function listSellerListingImages(sellerBusinessId: string, listingId: string): Promise<ListingImageView[]> {
  const listing = await loadOwnedListing(sellerBusinessId, listingId);
  const rows = await prisma.listingImage.findMany({ where: { listingId: listing.id, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.map(toView);
}

/** Listing for its owner: `imageUrls` stays buyer-facing; `images` carries every non-deleted image with status + note. */
export async function getListingForSeller(sellerBusinessId: string, listingId: string): Promise<(ListingView & { images: ListingImageView[] }) | null> {
  const l = await getListing(listingId);
  if (!l || l.sellerBusinessId !== sellerBusinessId) return null;
  return { ...l, images: await listSellerListingImages(sellerBusinessId, listingId) };
}

export async function deleteListingImage(sellerBusinessId: string, imageId: string): Promise<void> {
  const img = await loadOwnedImage(sellerBusinessId, imageId);
  await prisma.listingImage.update({ where: { id: img.id }, data: { deletedAt: new Date() } });
  // Bytes go immediately; the row lingers 30 days (rejected-hash dedupe, audit) then the purge job removes it.
  await getMediaStore().delete(img.storageKey).catch((e) => console.error("[catalogue] image storage delete failed", e));
  await removePublicVariants(img).catch((e) => console.error("[catalogue] variant cleanup failed", e));
  await bustListingCaches(img.listingId, img.sellerBusinessId);
}

/** `orderedIds` is the desired order; images the seller omits keep their relative order after the listed ones. */
export async function reorderListingImages(sellerBusinessId: string, listingId: string, orderedIds: string[]): Promise<ListingImageView[]> {
  const listing = await loadOwnedListing(sellerBusinessId, listingId);
  const rows = await prisma.listingImage.findMany({ where: { listingId: listing.id, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  const known = new Set(rows.map((r) => r.id));
  if (orderedIds.some((id) => !known.has(id)) || new Set(orderedIds).size !== orderedIds.length) throw new DomainError("validation", "Unknown image in order");
  const order = [...orderedIds, ...rows.map((r) => r.id).filter((id) => !orderedIds.includes(id))];
  await prisma.$transaction(order.map((id, i) => prisma.listingImage.update({ where: { id }, data: { sortOrder: i } })));
  await bustListingCaches(listing.id, sellerBusinessId);
  return listSellerListingImages(sellerBusinessId, listingId);
}

/** Editing alt text changes what buyers would read, so an approved/rejected image goes back to review. */
export async function setImageAltText(sellerBusinessId: string, imageId: string, altText: string | null): Promise<ListingImageView> {
  const img = await loadOwnedImage(sellerBusinessId, imageId);
  const next = cleanAlt(altText);
  if (next === img.altText) return toView(img);
  const listing = await prisma.listing.findUnique({ where: { id: img.listingId } });
  const screen = await prescreen(img.listingId, listing?.title ?? "", next, undefined);
  const row = await prisma.listingImage.update({
    where: { id: img.id },
    data: { altText: next, status: screen.flagged ? "flagged" : "pending", moderationNote: null, moderatedBy: null, moderatedAt: null, aiVerdict: screen.verdict },
  });
  // Back in review: the public derivatives must disappear until re-approval (which regenerates them).
  await removePublicVariants(img).catch((e) => console.error("[catalogue] variant cleanup failed", e));
  await bustListingCaches(img.listingId, sellerBusinessId);
  return toView(row);
}

// ---- ops (admin) ----

export async function listImageModerationQueue(opts: { status?: "pending" | "flagged"; cursor?: string; limit?: number } = {}): Promise<{ items: ImageModerationItem[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 24)));
  const cursor = opts.cursor && isUuid(opts.cursor) ? opts.cursor : undefined;
  const rows = await prisma.listingImage.findMany({
    where: { deletedAt: null, status: opts.status ?? { in: ["pending", "flagged"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // oldest first
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { listing: { select: { title: true } } },
  });
  const page = rows.slice(0, limit);
  const profiles = await getTrustProfiles(page.map((r) => r.sellerBusinessId));
  return {
    items: page.map((r) => ({
      ...toView(r),
      listingId: r.listingId,
      listingTitle: r.listing.title,
      sellerBusinessId: r.sellerBusinessId,
      sellerName: profiles.get(r.sellerBusinessId)?.name ?? "Unknown seller",
      aiVerdict: r.aiVerdict,
      mimeType: r.mimeType,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

export async function getImageForModeration(id: string): Promise<ImageModerationItem | null> {
  const r = isUuid(id) ? await prisma.listingImage.findUnique({ where: { id }, include: { listing: { select: { title: true } } } }) : null;
  if (!r || r.deletedAt) return null;
  const profiles = await getTrustProfiles([r.sellerBusinessId]);
  return {
    ...toView(r),
    listingId: r.listingId,
    listingTitle: r.listing.title,
    sellerBusinessId: r.sellerBusinessId,
    sellerName: profiles.get(r.sellerBusinessId)?.name ?? "Unknown seller",
    aiVerdict: r.aiVerdict,
    mimeType: r.mimeType,
  };
}

/** Rejection requires a note (shown to the seller). Returns before/after for the admin audit trail. */
export async function moderateListingImage(
  id: string,
  decision: "approved" | "rejected",
  note: string | null | undefined,
  staffId: string,
): Promise<{ before: { status: ImageStatus; moderationNote: string | null }; after: { status: ImageStatus; moderationNote: string | null } }> {
  const cleanNote = note?.trim().slice(0, 500) || null;
  if (decision === "rejected" && !cleanNote) throw new DomainError("validation", "A reason is required when rejecting an image");
  if (!isUuid(staffId)) throw new DomainError("forbidden", "Staff member required");
  const img = isUuid(id) ? await prisma.listingImage.findUnique({ where: { id } }) : null;
  if (!img || img.deletedAt) throw new DomainError("not_found", "Image not found");
  if (img.status === decision) throw new DomainError("conflict", `Image is already ${decision}`);
  const before = { status: img.status, moderationNote: img.moderationNote };
  const after = { status: decision as ImageStatus, moderationNote: decision === "rejected" ? cleanNote : null };
  await prisma.$transaction(async (tx) => {
    // Guard against a concurrent decision: only transition from the status we read.
    const res = await tx.listingImage.updateMany({
      where: { id: img.id, status: img.status, deletedAt: null },
      data: { status: decision, moderationNote: after.moderationNote, moderatedBy: staffId, moderatedAt: new Date() },
    });
    if (res.count === 0) throw new DomainError("conflict", "Image was changed by someone else; refresh and retry");
    await emit(tx, "ListingImageModerated", { type: "listing_image", id: img.id }, { imageId: img.id, listingId: img.listingId, sellerBusinessId: img.sellerBusinessId, status: decision, moderatedBy: staffId });
  });
  if (decision === "approved") await enqueueImageProcessing(img.id);
  else await removePublicVariants(img).catch((e) => console.error("[catalogue] variant cleanup failed", e));
  await bustListingCaches(img.listingId, img.sellerBusinessId);
  return { before, after };
}

export type ImageViewer = { kind: "public" } | { kind: "seller"; sellerBusinessId: string } | { kind: "staff" };

/**
 * Visibility gate for image bytes. public: approved AND listing published+approved; seller: own images, any
 * status; staff: any. Deleted images are never served. Callers must authenticate/authorise `viewer` themselves.
 */
export async function readListingImage(id: string, viewer: ImageViewer): Promise<{ bytes: Uint8Array; contentType: string; sha256: string; status: ImageStatus } | null> {
  if (!isUuid(id)) return null;
  const img = await prisma.listingImage.findUnique({ where: { id }, include: { listing: { select: { status: true, moderationStatus: true } } } });
  if (!img || img.deletedAt) return null;
  if (viewer.kind === "public") {
    if (img.status !== "approved" || img.listing.status !== "published" || img.listing.moderationStatus !== "approved") return null;
  } else if (viewer.kind === "seller") {
    if (img.sellerBusinessId !== viewer.sellerBusinessId) return null;
  } else if (viewer.kind !== "staff") return null;
  const obj = await getMediaStore().get(img.storageKey);
  if (!obj) return null;
  return { bytes: obj.bytes, contentType: obj.contentType || (img.mimeType as ImageMime), sha256: img.sha256, status: img.status };
}

export type ImageDelivery = { kind: "redirect"; url: string; cacheControl: string } | { kind: "bytes"; bytes: Uint8Array; contentType: string; sha256: string; status: ImageStatus };

/**
 * Same visibility rules as readListingImage, but remote drivers answer with a redirect instead of proxying bytes:
 * public viewers get the CDN URL of a processed derivative (else a 5-minute signed URL of the private original);
 * seller/staff get a 5-minute signed URL of the original (never cached). Local driver streams bytes.
 */
export async function getListingImageDelivery(id: string, viewer: ImageViewer, opts: { signedTtlSeconds?: number } = {}): Promise<ImageDelivery | null> {
  if (!isUuid(id)) return null;
  const img = await prisma.listingImage.findUnique({ where: { id }, include: { listing: { select: { status: true, moderationStatus: true } } } });
  if (!img || img.deletedAt) return null;
  if (viewer.kind === "public") {
    if (img.status !== "approved" || img.listing.status !== "published" || img.listing.moderationStatus !== "approved") return null;
  } else if (viewer.kind === "seller") {
    if (img.sellerBusinessId !== viewer.sellerBusinessId) return null;
  } else if (viewer.kind !== "staff") return null;
  const ttl = opts.signedTtlSeconds ?? 300;
  if (viewer.kind === "public" && img.processedAt) {
    const jpegs = parseVariants(img.variants).filter((v) => v.format === "jpeg").sort((a, b) => a.width - b.width);
    const best = [...jpegs].reverse().find((v) => v.width <= 1280) ?? jpegs[0];
    const url = best ? getPublicMediaStore().publicUrl(best.key) : null;
    if (url) return { kind: "redirect", url, cacheControl: "public, max-age=3600" };
  }
  const store = getMediaStore();
  const signed = await store.signedGetUrl(img.storageKey, ttl);
  if (signed) return { kind: "redirect", url: signed, cacheControl: viewer.kind === "public" ? `public, max-age=${Math.max(0, ttl - 60)}` : "private, no-store" };
  const obj = await store.get(img.storageKey);
  if (!obj) return null;
  return { kind: "bytes", bytes: obj.bytes, contentType: obj.contentType || (img.mimeType as ImageMime), sha256: img.sha256, status: img.status };
}

/** Worker job: purge bytes + rows for images soft-deleted more than 30 days ago. */
export async function purgeDeletedListingImages(now = new Date(), batch = 200): Promise<number> {
  const rows = await prisma.listingImage.findMany({ where: { deletedAt: { lt: new Date(now.getTime() - PURGE_AFTER_MS) } }, take: batch, orderBy: { deletedAt: "asc" } });
  const store = getMediaStore();
  let n = 0;
  for (const r of rows) {
    try {
      await store.delete(r.storageKey);
      await removePublicVariants(r, { clearRow: false });
      await prisma.listingImage.delete({ where: { id: r.id } });
      n++;
    } catch (e) {
      console.error("[catalogue] image purge failed", r.id, e);
    }
  }
  return n;
}
