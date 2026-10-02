import { describe, expect, it } from "vitest";
import { enquiryRequirement, enquiryTitle, groupBySupplier, type BulkListing } from "@/features/wishlist/bulk";

const l = (id: string, seller: string, over: Partial<BulkListing> = {}): BulkListing => ({ id, title: `Product ${id}`, sellerBusinessId: seller, category: { slug: "packaging" }, moq: null, moqUnit: null, ...over });

describe("wishlist bulk RFQ shaping", () => {
  it("groups products by supplier in selection order, one enquiry per supplier", () => {
    const g = groupBySupplier([l("a", "s1"), l("b", "s2"), l("c", "s1")]);
    expect(g.map((x) => [x.sellerBusinessId, x.listings.map((y) => y.id)])).toEqual([["s1", ["a", "c"]], ["s2", ["b"]]]);
  });
  it("titles fit the enquiry schema (5..140) and say how many more", () => {
    const [g] = groupBySupplier([l("a", "s1", { title: "x".repeat(300) }), l("b", "s1")]);
    const t = enquiryTitle(g!);
    expect(t.length).toBeGreaterThanOrEqual(5);
    expect(t.length).toBeLessThanOrEqual(140);
    expect(enquiryTitle(groupBySupplier([l("a", "s1", { title: "Kraft Box" })])[0]!)).toBe("Quote request: Kraft Box");
    expect(enquiryTitle(groupBySupplier([l("a", "s1", { title: "Kraft Box" }), l("b", "s1")])[0]!)).toBe("Quote request: Kraft Box +1 more");
  });
  it("lists products with their minimum order and stays within the 4000 character limit", () => {
    const g = groupBySupplier([l("a", "s1", { title: "Kraft Box", moq: 500, moqUnit: "pcs" }), l("b", "s1", { title: "Tape" })])[0]!;
    const r = enquiryRequirement(g);
    expect(r).toContain("- Kraft Box (minimum order 500 pcs)");
    expect(r).toContain("- Tape");
    const many = groupBySupplier(Array.from({ length: 20 }, (_, i) => l(String(i), "s1", { title: "y".repeat(300) })))[0]!;
    expect(enquiryRequirement(many).length).toBeLessThanOrEqual(4000);
  });
});
