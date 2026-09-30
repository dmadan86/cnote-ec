import { describe, expect, it, vi } from "vitest";

const cats = [
  { id: "1", slug: "apparel", parentId: null },
  { id: "2", slug: "knitwear", parentId: "1" },
  { id: "3", slug: "tshirts", parentId: "2" },
  { id: "4", slug: "steel", parentId: null },
];
vi.mock("@cnote/catalogue", () => ({
  listCategories: async () => cats,
  listPublicListingIndex: async ({ offset, limit }: { offset: number; limit: number }) => {
    const all = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, title: "t", categorySlug: i < 4 ? "tshirts" : "steel", updatedAt: "x" }));
    return all.slice(offset, offset + limit);
  },
  getPublicListingsByIds: async (ids: string[]) => ids.map((id) => ({ id, sellerBusinessId: id === "l3" ? "s0" : `s${id.slice(1)}` })),
  LANGS: ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((id) => [id, { businessId: id, verificationTier: id === "s1" ? 0 : 1 }])),
}));

import { defaultStatsPort, expandCategorySlugs, getVerticalStatsPort, setVerticalStatsPort } from "../src/stats";

describe("stats port", () => {
  it("expands descendants and keeps unknown slugs", async () => {
    expect([...(await expandCategorySlugs(["apparel", "ghost"]))].sort()).toEqual(["apparel", "ghost", "knitwear", "tshirts"]);
  });
  it("counts distinct verified sellers with live listings in the tree", async () => {
    // listings l0..l3 in tshirts -> sellers s0,s1,s2,s0 ; s1 is tier 0
    expect(await defaultStatsPort.countVerifiedSellers(["apparel"], 1)).toBe(2);
    expect(await defaultStatsPort.countVerifiedSellers(["apparel"], 0)).toBe(3);
    expect(await defaultStatsPort.countVerifiedSellers(["steel"], 1)).toBe(2);
  });
  it("can be swapped and reset", async () => {
    setVerticalStatsPort({ countVerifiedSellers: async () => 7 });
    expect(await getVerticalStatsPort().countVerifiedSellers([], 1)).toBe(7);
    setVerticalStatsPort(null);
    expect(getVerticalStatsPort()).toBe(defaultStatsPort);
  });
});
