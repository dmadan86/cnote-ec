// @cnote/catalogue — categories, listings, moderation (ADR-003, ADR-004).
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { reindexStaleEmbeddings } from "./reindex";
import { purgeDeletedListingImages, type ListingImageView } from "./images";
import { versionHandlers, versionJobs } from "./worker";
import { processListingImage } from "./image-variants";
import { transcribeVoiceNote } from "./voice";

export interface CategoryView {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  leadCap: number;
  prohibited: boolean;
  attributeSchema: { fields: { key: string; label: string; type: "text" | "number" | "select"; required?: boolean; unit?: string; options?: string[] }[] };
  parentId: string | null;
}

export interface ListingView {
  id: string;
  sellerBusinessId: string;
  category: { id: string; slug: string; name: string };
  title: string;
  description: string;
  attributes: Record<string, string | number>;
  pricePaise: number | null;
  priceUnit: string | null;
  moq: number | null;
  moqUnit: string | null;
  hsn: string | null;
  language: string;
  imageUrls: string[];
  /** Tiny blur-up data URLs parallel to `imageUrls` (null when an image has none). Only populated on views served from LIVE. */
  imageBlurs?: (string | null)[];
  /** Seller's own product code (working copy only; not projected to LIVE). */
  sku?: string | null;
  /** Seller/admin contexts only (see getListingForSeller); never populated by getListing. */
  images?: ListingImageView[];
  aiGenerated: boolean;
  status: "draft" | "published" | "archived";
  moderationStatus: "pending" | "approved" | "review" | "rejected";
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on views served from the LIVE database: the published version number and the seller snapshot taken at publish. */
  liveVersion?: number;
  seller?: { name: string; city: string | null; state: string | null; verificationTier: number; trustScore: number; badgeActive: boolean };
}

export interface ListingInput {
  categoryId: string;
  title: string;
  description: string;
  attributes: Record<string, string | number>;
  pricePaise: number | null;
  priceUnit: string | null;
  moq: number | null;
  moqUnit: string | null;
  hsn: string | null;
  language: string;
  imageUrls: string[];
  /** optional seller product code; unique per seller (DomainError "conflict" on duplicate) */
  sku?: string | null;
}

export { listCategories, getCategoryBySlug, getCategoryById, upsertCategories, type CategoryDef } from "./categories";
export {
  getListing, getListingsByIds, getPublicListing, getPublicListingsByIds, listPublicSellerListings, listPublicListingIndex, countPublicListings, type ListingIndexEntry, listSellerListings, listFeaturedListings, draftListingFromText,
  createListing, updateListing, publishListing, unpublishListing, archiveListing, resolveListingModeration,
} from "./listings";
export { findSellerCandidates, retrieveListings, suggestListingTitles } from "./retrieval";
export {
  uploadListingImage, listSellerListingImages, getListingForSeller, deleteListingImage, reorderListingImages, setImageAltText,
  listImageModerationQueue, getImageForModeration, moderateListingImage, readListingImage, purgeDeletedListingImages,
  listingImageUrl, MAX_IMAGES_PER_LISTING, getListingImageDelivery, type ImageDelivery,
  type ListingImageView, type ImageModerationItem, type ImageViewer, type ImageStatus,
} from "./images";
export {
  publicImagesForListing, publicImagesForListings, toPublicImage, processListingImage, backfillImageVariants, enqueueImageProcessing,
  type PublicListingImage, type StoredVariant, type ProcessResult,
} from "./image-variants";
export { reindexEmbeddings, reindexStaleEmbeddings } from "./reindex";

const DAY_MS = 24 * 60 * 60 * 1000;
export const worker: ModuleWorker = {
  name: "catalogue",
  handlers: { ...versionHandlers },
  queues: [queueConsumer("media.process_image", async (msg) => void (await processListingImage(msg.payload.imageId)), 2),
    // ADR-004: async voice transcription (idempotent; provider failures throw so the queue retries, then dead-letters)
    queueConsumer("catalogue.transcribe", async (msg) => void (await transcribeVoiceNote(msg.payload.voiceNoteId, { language: msg.payload.language })), 2),
  ],
  jobs: [
    ...versionJobs,
    { name: "catalogue.reembed-stale", everyMs: DAY_MS, run: async () => void (await reindexStaleEmbeddings()) },
    { name: "catalogue.purge-deleted-images", everyMs: DAY_MS, run: async () => void (await purgeDeletedListingImages()) },
  ],
};

export * from "./getters";
export * from "./versions";
export { publishVersion, publishDueVersions, reconcileLive, reprojectSeller, reprojectImages, backfillLiveListings } from "./live";
export { findSellerListingBySku, findSellerListingsBySkus } from "./sku";
export { validateAttributes, coerceAttributes, LANGS, SKU_RE } from "./validate";
export * from "./retention";
export * from "./voice";
export * from "./photo-draft";
export * from "./price-history";
