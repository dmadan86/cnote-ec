// @cnote/catalogue — categories, listings, moderation (ADR-003, ADR-004).
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";

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

export async function listCategories(): Promise<CategoryView[]> {
  throw new Error("not implemented");
}
export async function getCategoryBySlug(slug: string): Promise<CategoryView | null> {
  void slug;
  throw new Error("not implemented");
}
export async function getListing(id: string): Promise<ListingView | null> {
  void id;
  throw new Error("not implemented");
}
export async function getListingsByIds(ids: string[]): Promise<ListingView[]> {
  void ids;
  throw new Error("not implemented");
}
export async function listSellerListings(sellerBusinessId: string): Promise<ListingView[]> {
  void sellerBusinessId;
  throw new Error("not implemented");
}
/** Popular/new published+approved listings for home page rails. */
export async function listFeaturedListings(opts: { sort: "popular" | "new"; limit: number }): Promise<ListingView[]> {
  void opts;
  throw new Error("not implemented");
}

/** AI-assisted onboarding (ADR-004): free text (or transcript) → structured draft. Marked aiGenerated. */
export async function draftListingFromText(sellerBusinessId: string, text: string, language: string): Promise<ListingView> {
  void sellerBusinessId; void text; void language;
  throw new Error("not implemented");
}
export async function createListing(sellerBusinessId: string, input: ListingInput): Promise<ListingView> {
  void sellerBusinessId; void input;
  throw new Error("not implemented");
}
export async function updateListing(sellerBusinessId: string, listingId: string, input: Partial<ListingInput>): Promise<ListingView> {
  void sellerBusinessId; void listingId; void input;
  throw new Error("not implemented");
}
/** Validates against category schema, runs moderation, embeds, publishes (or → review/rejected). */
export async function publishListing(sellerBusinessId: string, listingId: string): Promise<ListingView> {
  void sellerBusinessId; void listingId;
  throw new Error("not implemented");
}
export async function archiveListing(sellerBusinessId: string, listingId: string): Promise<void> {
  void sellerBusinessId; void listingId;
  throw new Error("not implemented");
}
/** Ops decision on a listing in moderation review. */
export async function resolveListingModeration(listingId: string, outcome: "approved" | "rejected", reason?: string): Promise<void> {
  void listingId; void outcome; void reason;
  throw new Error("not implemented");
}

/** For matching (ADR-002): best-matching published listing per seller by vector similarity. */
export async function findSellerCandidates(opts: {
  embedding: number[];
  categoryId: string | null;
  limit: number;
  excludeSellerIds?: string[];
}): Promise<{ sellerBusinessId: string; listingId: string; similarity: number }[]> {
  void opts;
  throw new Error("not implemented");
}

/** Raw hybrid retrieval for @cnote/search (published + approved only). Fusion/ranking happens in search. */
export async function retrieveListings(opts: {
  text?: string;
  embedding?: number[];
  categoryId?: string | null;
  limit: number;
}): Promise<{ listingId: string; sellerBusinessId: string; lexicalRank: number; similarity: number }[]> {
  void opts;
  throw new Error("not implemented");
}

export const worker: ModuleWorker = { name: "catalogue", handlers: {}, jobs: [] };
