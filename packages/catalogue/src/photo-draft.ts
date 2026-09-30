// Photos → editable AI draft listing (ADR-004, ADR-008). Nothing here publishes: the listing is a draft, and every
// photo lands as a pending/flagged ListingImage that staff must still approve before buyers can see it.
import { randomUUID } from "node:crypto";
import * as ai from "@cnote/ai";
import { DomainError, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { ImageValidationError, VARIANT_WIDTHS, processImage, validateImage, type ValidatedImage } from "@cnote/media";
import { listCategories } from "./categories";
import { uploadListingImage, MAX_IMAGES_PER_LISTING, type ListingImageView } from "./images";
import { listingInclude, toListingView } from "./mappers";
import { LANGS, coerceAttributes } from "./validate";
import type { ListingView } from "./index";

export const MAX_PHOTOS_PER_DRAFT = 4;
export const PHOTO_DRAFTS_PER_HOUR = 20;
/** Long edge sent to the vision model (Anthropic downscales beyond ~1568 px anyway; smaller is cheaper and faster). */
const AI_LONG_EDGE = 1568;
const STORE_MAX_WIDTH = 1920;
const HINT_MAX = 2000;

export interface PhotoDraftResult {
  listing: ListingView;
  images: ListingImageView[];
  /** photos that were validated and analysed but could not be attached (duplicate, rate limit, ...) */
  skipped: { filename: string | null; reason: string }[];
  ai: {
    decisionId: string;
    confidence: number;
    needsReview: boolean;
    visualAttributes: Record<string, string>;
    detected: { productType: string; quantityVisible: number | null };
  };
}

const largestWidth = (max: number) => [...VARIANT_WIDTHS].reverse().find((w) => w <= max) ?? VARIANT_WIDTHS[0];

export async function draftListingFromPhotos(
  sellerBusinessId: string,
  personId: string,
  input: { files: { bytes: Uint8Array; filename?: string }[]; hintText?: string; language: string },
): Promise<PhotoDraftResult> {
  const { files } = input;
  if (files.length < 1 || files.length > MAX_PHOTOS_PER_DRAFT) throw new DomainError("validation", `Add 1 to ${MAX_PHOTOS_PER_DRAFT} photos`, undefined, "catalogue.addPhotos", { maxPhotosPerDraft: MAX_PHOTOS_PER_DRAFT });
  const hint = input.hintText?.trim().slice(0, HINT_MAX) || undefined;
  const lang = (LANGS as readonly string[]).includes(input.language) ? (input.language as (typeof LANGS)[number]) : "en";

  // 1. Validate by magic bytes/dimensions (never the client's content-type), then strip metadata + resize.
  const prepared: { file: (typeof files)[number]; v: ValidatedImage; ai: { bytes: Uint8Array; width: number; height: number }; store: Uint8Array }[] = [];
  for (const file of files) {
    let v: ValidatedImage;
    try {
      v = validateImage(file.bytes);
    } catch (e) {
      throw e instanceof ImageValidationError ? new DomainError("validation", `${file.filename ?? "A photo"}: ${e.message}`) : e;
    }
    const aiWidth = largestWidth(Math.min(v.width, Math.floor((AI_LONG_EDGE * v.width) / Math.max(v.width, v.height))));
    const storeWidth = largestWidth(Math.min(v.width, STORE_MAX_WIDTH));
    // processImage drops EXIF/GPS/ICC and bakes in orientation; jpeg only keeps this to one encode per size.
    const out = await processImage(file.bytes, { listingId: randomUUID(), imageId: randomUUID() }, { widths: [...new Set([aiWidth, storeWidth])], formats: ["jpeg"] });
    const pick = (w: number) => out.variants.find((x) => x.width === w) ?? out.variants[out.variants.length - 1]!;
    const a = pick(aiWidth);
    prepared.push({ file, v, ai: { bytes: a.data, width: a.width, height: a.height }, store: pick(storeWidth).data });
  }

  if (!(await rateLimit(`photo-draft:${personId}`, PHOTO_DRAFTS_PER_HOUR, 3600))) {
    throw new DomainError("rate_limited", "Too many photo drafts. Please try again in a while.");
  }

  const usable = (await listCategories()).filter((c) => !c.prohibited);
  if (!usable.length) throw new DomainError("conflict", "No categories available", undefined, "catalogue.noCategoriesAvailable");

  // 2. Vision extraction (decision logged with hashes/dimensions only; low confidence goes to the review queue).
  const id = randomUUID();
  const ex = await ai.extractListingFromImages(
    {
      images: prepared.map((p) => ({ bytes: p.ai.bytes, mimeType: "image/jpeg", width: p.ai.width, height: p.ai.height })),
      hintText: hint, language: lang, categories: usable.map((c) => ({ slug: c.slug, name: c.name, attributeSchema: c.attributeSchema })),
    },
    { type: "listing", id },
  );

  // 3. Editable draft, always aiGenerated, never published.
  const category = usable.find((c) => c.slug === ex.categorySlug) ?? usable[0]!;
  const attrs = coerceAttributes(
    category.attributeSchema,
    Object.fromEntries(Object.entries({ ...ex.visualAttributes, ...ex.attributes }).filter(([, v]) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))),
  );
  const int = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null);
  const fallbackTitle = hint ?? "New product";
  const row = await prisma.listing.create({
    data: {
      id, sellerBusinessId, categoryId: category.id,
      title: (ex.title?.trim() || fallbackTitle).slice(0, 200),
      description: (ex.description?.trim() || hint || "").slice(0, 5000),
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

  // 4. Attach the metadata-free photos: pending staff approval (uploadListingImage never auto-approves).
  const images: ListingImageView[] = [];
  const skipped: PhotoDraftResult["skipped"] = [];
  for (const p of prepared.slice(0, MAX_IMAGES_PER_LISTING)) {
    try {
      images.push(await uploadListingImage(sellerBusinessId, id, { bytes: p.store, filename: p.file.filename }));
    } catch (e) {
      skipped.push({ filename: p.file.filename ?? null, reason: e instanceof DomainError ? e.message : "Upload failed" });
    }
  }
  return {
    listing: toListingView(row), images, skipped,
    ai: { decisionId: ex.decisionId, confidence: ex.confidence, needsReview: ex.needsReview, visualAttributes: ex.visualAttributes, detected: ex.detected },
  };
}
