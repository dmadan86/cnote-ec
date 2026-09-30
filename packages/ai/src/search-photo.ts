// "Search by photo" (ADR-004, ADR-008, ADR-009): turns one product photo into a text query + category hint.
// It reuses the vision extractor (`extractListingFromImages`) so the prompt/model/eval gate and the AiDecision audit
// are the same as for photo listing drafts; this file only DERIVES the search query from that output.
import { extractListingFromImages, type AiResult, type ExtractListingFromImagesInput, type ExtractListingFromImagesOutput, type Subject } from "./index";

export interface PhotoSearchQuery {
  /** space-separated keywords, "" when the photo was not recognised */
  query: string;
  keywords: string[];
  /** the extractor's category guess, only when it is one of the offered categories */
  categorySlug: string | null;
}
export type PhotoSearchResult = PhotoSearchQuery & { decisionId: string; confidence: number; needsReview: boolean };

/** Above this the category is trusted enough to narrow results; below it it is only a suggestion. */
export const PHOTO_CATEGORY_CONFIDENCE = 0.6;
export const MAX_PHOTO_KEYWORDS = 5;
const PLACEHOLDER_TITLES = new Set(["untitled product", "untitled", ""]);
const KEYWORD_ATTRS = ["colour", "color", "material", "finish", "pattern"];

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length >= 2);

/** Pure: extractor output -> keywords. Product type first, then the title's words, then up to 2 visual attributes; deduped, capped. */
export function deriveSearchQuery(o: Pick<ExtractListingFromImagesOutput, "title" | "detected" | "visualAttributes" | "categorySlug">, offered: string[] = []): PhotoSearchQuery {
  const title = PLACEHOLDER_TITLES.has(o.title.trim().toLowerCase()) ? "" : o.title;
  const attrs = KEYWORD_ATTRS.flatMap((k) => (o.visualAttributes[k] ? [o.visualAttributes[k]!] : [])).slice(0, 2);
  const keywords = [...new Set([...words(o.detected.productType), ...words(title), ...attrs.flatMap(words)])].slice(0, MAX_PHOTO_KEYWORDS);
  const categorySlug = o.categorySlug && offered.includes(o.categorySlug) ? o.categorySlug : null;
  return { query: keywords.join(" "), keywords, categorySlug };
}

/** Photo -> search query. The photo bytes are validated (EXIF-free, 1 image) by the underlying capability and never stored. */
export async function deriveImageSearch(
  input: Pick<ExtractListingFromImagesInput, "images" | "language" | "categories">,
  subject: Subject,
): Promise<AiResult<PhotoSearchQuery>> {
  const r = await extractListingFromImages({ ...input, images: input.images.slice(0, 1) }, subject);
  const q = deriveSearchQuery(r, input.categories.map((c) => c.slug));
  return { ...q, decisionId: r.decisionId, confidence: r.confidence, needsReview: r.needsReview };
}
