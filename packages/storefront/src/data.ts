// Render-time platform data: trust, listings, ratings and approved reviews. Everything here is live, public and
// filtered to approved content; none of it is stored in (or editable through) the document.
import { listPublicSellerListings, listSellerListingImages, listSellerListings } from "@cnote/catalogue";
import { DomainError } from "@cnote/core";
import { getTrustProfiles } from "@cnote/identity";
import { getRatingSummaries, listApprovedReviews } from "@cnote/reviews";
import { approvedEmbedKeys } from "./embeds";
import type { RenderData, RenderTestimonial } from "./render/types";

const MAX_PRODUCTS = 60;
const REVIEW_SOURCES = 6;

export async function loadRenderData(sellerBusinessId: string): Promise<RenderData> {
  const [profiles, listings] = await Promise.all([getTrustProfiles([sellerBusinessId]), listPublicSellerListings(sellerBusinessId)]);
  const p = profiles.get(sellerBusinessId);
  if (!p) throw new DomainError("not_found", "Seller not found.", undefined, "storefront.sellerNotFound");
  const shown = listings.slice(0, MAX_PRODUCTS);
  const ids = shown.map((l) => l.id);

  const summaries = ids.length ? await getRatingSummaries(ids).catch(() => new Map()) : new Map();
  let count = 0;
  let sum = 0;
  for (const s of summaries.values()) {
    count += s.count;
    sum += s.average * s.count;
  }

  // Testimonials: only approved platform reviews, 4★+ (most helpful first), drawn from the best-reviewed products.
  const rated = shown
    .map((l) => ({ l, n: summaries.get(l.id)?.count ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, REVIEW_SOURCES);
  const pages = await Promise.all(rated.map(({ l }) => listApprovedReviews(l.id, { sort: "helpful", limit: 3 }).then((pg) => pg.items.map((r) => ({ r, l }))).catch(() => [])));
  const testimonials: RenderTestimonial[] = pages
    .flat()
    .filter(({ r }) => r.rating >= 4 && r.body.trim().length >= 20)
    .sort((a, b) => b.r.helpfulCount - a.r.helpfulCount || b.r.rating - a.r.rating || b.r.createdAt.localeCompare(a.r.createdAt))
    .slice(0, 6)
    .map(({ r, l }) => ({
      id: r.id, rating: r.rating, title: r.title, body: r.body.slice(0, 400), authorName: r.authorName, productTitle: l.title, verifiedEnquiry: r.verifiedEnquiry,
    }));

  const categories = new Map<string, string>();
  for (const l of shown) categories.set(l.category.slug, l.category.name);

  return {
    business: { id: sellerBusinessId, name: p.name, city: p.city, state: p.state },
    trust: { tier: p.verificationTier, score: p.trustScore, badgeActive: p.badgeActive, gstVerified: p.verificationTier >= 1 },
    rating: count > 0 ? { average: Math.round((sum / count) * 10) / 10, count } : null,
    products: shown.map((l) => ({
      id: l.id,
      title: l.title,
      imageUrl: l.imageUrls[0] ?? null,
      imageAlt: l.title,
      pricePaise: l.pricePaise,
      priceUnit: l.priceUnit,
      moq: l.moq,
      moqUnit: l.moqUnit,
      categorySlug: l.category.slug,
      categoryName: l.category.name,
    })),
    categories: [...categories].map(([slug, name]) => ({ slug, name })),
    testimonials,
    approvedEmbeds: await approvedEmbedKeys(sellerBusinessId),
  };
}

export interface SellerImage {
  id: string;
  url: string;
  alt: string;
  listingId: string;
  listingTitle: string;
}

/**
 * The seller's APPROVED listing images: the only images a storefront may use (external URLs and pending/rejected
 * images are refused). Studio's image picker and publish-time verification both use this.
 */
export async function listApprovedSellerImages(sellerBusinessId: string): Promise<SellerImage[]> {
  const listings = (await listSellerListings(sellerBusinessId)).filter((l) => l.status !== "archived").slice(0, 100);
  const out: SellerImage[] = [];
  for (let i = 0; i < listings.length; i += 10) {
    const chunk = listings.slice(i, i + 10);
    const res = await Promise.all(chunk.map((l) => listSellerListingImages(sellerBusinessId, l.id).catch(() => [])));
    res.forEach((imgs, j) => {
      for (const im of imgs) {
        if (im.status === "approved") out.push({ id: im.id, url: im.url, alt: im.altText ?? chunk[j]!.title, listingId: chunk[j]!.id, listingTitle: chunk[j]!.title });
      }
    });
  }
  return out;
}
