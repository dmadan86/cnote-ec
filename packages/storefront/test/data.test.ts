import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  profiles: new Map<string, unknown>(),
  listings: [] as unknown[],
  summaries: new Map<string, { count: number; average: number }>(),
  reviews: new Map<string, unknown[]>(),
  sellerListings: [] as { id: string; title: string; status: string }[],
  images: new Map<string, { id: string; url: string; status: string; altText: string | null }[]>(),
  ratingFails: false,
  reviewFails: false,
  imageFails: new Set<string>(),
}));
vi.mock("@cnote/catalogue", () => ({
  listPublicSellerListings: async () => s.listings,
  listSellerListings: async () => s.sellerListings,
  listSellerListingImages: async (_b: string, id: string) => {
    if (s.imageFails.has(id)) throw new Error("x");
    return s.images.get(id) ?? [];
  },
}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async () => s.profiles }));
vi.mock("@cnote/reviews", () => ({
  getRatingSummaries: async () => {
    if (s.ratingFails) throw new Error("down");
    return s.summaries;
  },
  listApprovedReviews: async (id: string) => {
    if (s.reviewFails) throw new Error("down");
    return { items: s.reviews.get(id) ?? [], nextCursor: null };
  },
}));

import { listApprovedSellerImages, loadRenderData } from "../src/data";

const listing = (i: number, cat = "boxes") => ({
  id: `l${i}`, title: `Item ${i}`, imageUrls: i % 2 ? [`/media/listing-images/${i}`] : [], pricePaise: 100 * i, priceUnit: "pc", moq: 10, moqUnit: "pcs", category: { slug: cat, name: cat.toUpperCase() },
});
const review = (id: string, rating: number, body: string, helpful = 0, createdAt = "2026-01-01") => ({
  id, rating, title: null, body, authorName: "A", helpfulCount: helpful, createdAt, verifiedEnquiry: true,
});
const long = "This is a sufficiently long review body.";

beforeEach(() => {
  s.profiles = new Map([["b1", { businessId: "b1", name: "Acme", city: "Pune", state: "MH", verificationTier: 2, trustScore: 71, badgeActive: true }]]);
  s.listings = [];
  s.summaries = new Map();
  s.reviews = new Map();
  s.sellerListings = [];
  s.images = new Map();
  s.ratingFails = s.reviewFails = false;
  s.imageFails = new Set();
});

describe("loadRenderData", () => {
  it("throws not_found for an unknown seller", async () => {
    await expect(loadRenderData("nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("maps trust straight from the trust profile (never from anything seller-controlled)", async () => {
    const d = await loadRenderData("b1");
    expect(d.trust).toEqual({ tier: 2, score: 71, badgeActive: true, gstVerified: true });
    expect(d.business).toEqual({ id: "b1", name: "Acme", city: "Pune", state: "MH" });
    expect(d.rating).toBeNull();
    expect(d.products).toEqual([]);
  });
  it("caps products at 60, dedupes categories, weights rating by review count", async () => {
    s.listings = Array.from({ length: 75 }, (_, i) => listing(i, i % 2 ? "boxes" : "tapes"));
    s.summaries = new Map([["l0", { count: 3, average: 5 }], ["l1", { count: 1, average: 1 }]]);
    const d = await loadRenderData("b1");
    expect(d.products).toHaveLength(60);
    expect(d.categories).toHaveLength(2);
    expect(d.rating).toEqual({ average: 4, count: 4 });
    expect(d.products[1]!.imageUrl).toBe("/media/listing-images/1");
    expect(d.products[0]!.imageUrl).toBeNull();
  });
  it("testimonials: only 4-star+, substantive, most helpful first, max 6, body truncated", async () => {
    s.listings = [listing(1), listing(2)];
    s.summaries = new Map([["l1", { count: 5, average: 4.5 }], ["l2", { count: 2, average: 4 }]]);
    s.reviews.set("l1", [review("a", 5, long, 1), review("b", 3, long, 99), review("c", 5, "too short", 50), review("d", 4, "x".repeat(900), 5)]);
    s.reviews.set("l2", [review("e", 4, long, 5, "2026-02-01"), review("f", 5, long, 5, "2026-03-01")]);
    const d = await loadRenderData("b1");
    expect(d.testimonials.map((t) => t.id)).toEqual(["f", "e", "d", "a"]);
    expect(d.testimonials.find((t) => t.id === "d")!.body).toHaveLength(400);
    expect(d.testimonials.some((t) => t.id === "b" || t.id === "c")).toBe(false);
    expect(d.testimonials[0]!.productTitle).toBeTruthy();
  });
  it("caps testimonials at 6", async () => {
    s.listings = [listing(1)];
    s.summaries = new Map([["l1", { count: 20, average: 5 }]]);
    s.reviews.set("l1", Array.from({ length: 10 }, (_, i) => review(`r${i}`, 5, long, i)));
    expect((await loadRenderData("b1")).testimonials).toHaveLength(6);
  });
  it("degrades gracefully when the reviews service fails", async () => {
    s.listings = [listing(1)];
    s.summaries = new Map([["l1", { count: 2, average: 5 }]]);
    s.ratingFails = true;
    let d = await loadRenderData("b1");
    expect(d.rating).toBeNull();
    s.ratingFails = false;
    s.reviewFails = true;
    d = await loadRenderData("b1");
    expect(d.testimonials).toEqual([]);
    expect(d.rating).not.toBeNull();
  });
});

describe("listApprovedSellerImages", () => {
  it("returns only APPROVED images of non-archived listings, alt falls back to title", async () => {
    s.sellerListings = [{ id: "a", title: "A", status: "published" }, { id: "b", title: "B", status: "archived" }, { id: "c", title: "C", status: "draft" }];
    s.images.set("a", [{ id: "i1", url: "/u1", status: "approved", altText: "alt" }, { id: "i2", url: "/u2", status: "pending", altText: null }, { id: "i3", url: "/u3", status: "rejected", altText: null }]);
    s.images.set("b", [{ id: "i4", url: "/u4", status: "approved", altText: null }]);
    s.images.set("c", [{ id: "i5", url: "/u5", status: "approved", altText: null }]);
    const out = await listApprovedSellerImages("b1");
    expect(out.map((i) => i.id)).toEqual(["i1", "i5"]);
    expect(out[1]).toMatchObject({ alt: "C", listingTitle: "C", listingId: "c" });
  });
  it("survives a failing listing, chunks over 10 and caps at 100 listings", async () => {
    s.sellerListings = Array.from({ length: 130 }, (_, i) => ({ id: `x${i}`, title: `T${i}`, status: "published" }));
    for (const id of ["x0", "x99", "x100"]) s.images.set(id, [{ id: `img-${id}`, url: "/u", status: "approved", altText: null }]);
    s.imageFails.add("x5");
    const out = await listApprovedSellerImages("b1");
    expect(out.map((i) => i.id)).toEqual(["img-x0", "img-x99"]);
  });
});
