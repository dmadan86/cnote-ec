// @cnote/catalogue — categories, listings, moderation (ADR-003, ADR-004).
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";
import { reindexStaleEmbeddings } from "./reindex";
import { purgeDeletedListingImages, type ListingImageView } from "./images";

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
  /** Seller/admin contexts only (see getListingForSeller); never populated by getListing. */
  images?: ListingImageView[];
  aiGenerated: boolean;
  status: "draft" | "published" | "archived";
  moderationStatus: "pending" | "approved" | "review" | "rejected";
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
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
}

export { listCategories, getCategoryBySlug, getCategoryById, upsertCategories, type CategoryDef } from "./categories";
export {
  getListing, getListingsByIds, getPublicListing, getPublicListingsByIds, listPublicSellerListings, listPublicListingIndex, countPublicListings, type ListingIndexEntry, listSellerListings, listFeaturedListings, draftListingFromText,
  createListing, updateListing, publishListing, archiveListing, resolveListingModeration,
} from "./listings";
export { findSellerCandidates, retrieveListings, suggestListingTitles } from "./retrieval";
export {
  uploadListingImage, listSellerListingImages, getListingForSeller, deleteListingImage, reorderListingImages, setImageAltText,
  listImageModerationQueue, getImageForModeration, moderateListingImage, readListingImage, purgeDeletedListingImages,
  listingImageUrl, MAX_IMAGES_PER_LISTING,
  type ListingImageView, type ImageModerationItem, type ImageViewer, type ImageStatus,
} from "./images";
export { reindexEmbeddings, reindexStaleEmbeddings } from "./reindex";

const DAY_MS = 24 * 60 * 60 * 1000;
export const worker: ModuleWorker = {
  name: "catalogue",
  handlers: {},
  jobs: [
    { name: "catalogue.reembed-stale", everyMs: DAY_MS, run: async () => void (await reindexStaleEmbeddings()) },
    { name: "catalogue.purge-deleted-images", everyMs: DAY_MS, run: async () => void (await purgeDeletedListingImages()) },
  ],
};
