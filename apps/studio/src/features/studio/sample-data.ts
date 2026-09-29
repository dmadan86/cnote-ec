import type { RenderData } from "@cnote/storefront/render";

/** Illustrative data for template thumbnails and previews (a seller's real data replaces it once they apply a template). */
export const SAMPLE_DATA: RenderData = {
  business: { id: "sample", name: "Your Business", city: "Your City", state: null },
  trust: { tier: 1, score: 68, badgeActive: true, gstVerified: true },
  rating: { average: 4.5, count: 18 },
  categories: [{ slug: "sample", name: "Sample" }],
  products: Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    title: ["Sample product one", "Sample product two", "Sample product three", "Sample product four", "Sample product five", "Sample product six", "Sample product seven", "Sample product eight"][i]!,
    imageUrl: null,
    imageAlt: "",
    pricePaise: 12500 + i * 2500,
    priceUnit: "pc",
    moq: 100 * (i + 1),
    moqUnit: "pcs",
    categorySlug: "sample",
    categoryName: "Sample",
  })),
  testimonials: [
    { id: "s1", rating: 5, title: "Reliable supplier", body: "Sample review text: quality was consistent and delivery arrived on the promised date.", authorName: "Sample buyer", productTitle: "Sample product one", verifiedEnquiry: true },
    { id: "s2", rating: 4, title: null, body: "Sample review text: good communication and fair pricing for a bulk order.", authorName: "Sample buyer", productTitle: "Sample product two", verifiedEnquiry: false },
  ],
};
