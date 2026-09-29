import { describe, expect, it } from "vitest";
import { extractListingHeuristic } from "../src/heuristic/extract";
import { scoreIntentHeuristic } from "../src/heuristic/intent";
import { moderateHeuristic } from "../src/heuristic/moderate";

const base = { title: "t", requirement: "r", buyerVerificationTier: 0, buyerPhoneVerified: false, buyerPriorEnquiries: 0, buyerPriorResponded: 0 };

describe("intent heuristic", () => {
  it("explains a strong enquiry to sellers", () => {
    const r = scoreIntentHeuristic({
      ...base, title: "Boxes 10x10x5", requirement: "Need 3 ply boxes 10x10x5 cm, 180 gsm for garment packing shipments.",
      quantity: 500, quantityUnit: "pieces", deliveryPincode: "560001", buyerPhoneVerified: true, buyerVerificationTier: 2,
    });
    expect(r.output.score).toBeGreaterThan(60);
    expect(r.output.reasons).toContain("Specific quantity: 500 pieces");
    expect(r.output.reasons).toContain("Delivery pincode provided");
    expect(r.confidence).toBeGreaterThan(0.55);
  });
  it("gives sparse input low confidence and new-buyer reasons", () => {
    const r = scoreIntentHeuristic({ ...base, title: "pipes", requirement: "need pipes" });
    expect(r.output.score).toBeLessThan(15);
    expect(r.confidence).toBeLessThan(0.55);
    expect(r.output.reasons).toContain("New buyer, no history");
  });
  it("rejects an invalid pincode", () => {
    const r = scoreIntentHeuristic({ ...base, requirement: "some longer requirement text here", deliveryPincode: "012345" });
    expect(r.output.reasons).not.toContain("Delivery pincode provided");
  });
});

describe("moderation heuristic", () => {
  it("blocks, reviews and allows", () => {
    expect(moderateHeuristic({ text: "tramadol 100mg wholesale" }).output).toMatchObject({ verdict: "block", flags: ["pharma"] });
    expect(moderateHeuristic({ text: "citric acid food grade" }).output.verdict).toBe("review");
    expect(moderateHeuristic({ text: "plastic injection moulding machine" }).output.verdict).toBe("allow");
  });
});

describe("extraction heuristic", () => {
  it("parses price in paise, MOQ, HSN", () => {
    const r = extractListingHeuristic({ text: "Cotton bags ₹5.20/piece, MOQ 500 pcs, HSN 4819", language: "en", categories: [] });
    expect(r.output).toMatchObject({ pricePaise: 520, priceUnit: "piece", moq: 500, moqUnit: "piece", hsn: "4819", categorySlug: null });
  });
});
