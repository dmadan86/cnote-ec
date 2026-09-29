import type { RenderData } from "@cnote/storefront/render";

/** Illustrative data for template previews. */
export const SAMPLE_DATA: RenderData = {
  business: { id: "sample", name: "Your Business", city: "Your City", state: null },
  trust: { tier: 1, score: 68, badgeActive: true, gstVerified: true },
  rating: { average: 4.5, count: 18 },
  categories: [{ slug: "sample", name: "Sample" }],
  products: Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`, title: `Sample product ${i + 1}`, imageUrl: null, imageAlt: "", pricePaise: 12500 + i * 2500, priceUnit: "pc",
    moq: 100 * (i + 1), moqUnit: "pcs", categorySlug: "sample", categoryName: "Sample",
  })),
  testimonials: [{ id: "s1", rating: 5, title: "Reliable supplier", body: "Sample review text: quality was consistent and delivery arrived on the promised date.", authorName: "Sample buyer", productTitle: "Sample product 1", verifiedEnquiry: true }],
};
