import { describe, expect, it } from "vitest";
import type { ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";
import { productLd } from "@/lib/schema";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base = {
  id: "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b", sellerBusinessId: "s1", category: { id: "c1", slug: "packaging", name: "Packaging" }, title: "Kraft Box", description: "Box",
  attributes: {}, pricePaise: 1250, priceUnit: "piece", moq: 500, moqUnit: "pcs", hsn: null, language: "en", imageUrls: [],
  aiGenerated: false, status: "published", moderationStatus: "approved", moderationReason: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
} as unknown as ListingView;
const seller = { businessId: "s1", name: "Acme Packs", city: "Surat", state: "Gujarat", verificationTier: 2, trustScore: 80, badgeActive: true, languages: ["en"] } as TrustProfile;

describe("product JSON-LD offers", () => {
  it("keeps the single Offer when there are no price tiers", () => {
    const o = (productLd(base, seller, null) as Json).offers;
    expect(o["@type"]).toBe("Offer");
    expect(o.price).toBe("12.50");
    expect(o.eligibleQuantity).toMatchObject({ minValue: 500, unitText: "pcs" });
  });
  it("emits an AggregateOffer with low/high price and an eligibleQuantity per slab", () => {
    const l = { ...base, priceTiers: [{ minQty: 1000, pricePaise: 1100 }, { minQty: 5000, pricePaise: 900 }] } as ListingView;
    const o = (productLd(l, seller, null) as Json).offers;
    expect(o["@type"]).toBe("AggregateOffer");
    expect(o.priceCurrency).toBe("INR");
    expect(o.lowPrice).toBe("9.00");
    expect(o.highPrice).toBe("12.50");
    expect(o.offerCount).toBe(3);
    expect(o.offers.map((x: Json) => x.eligibleQuantity)).toEqual([
      { "@type": "QuantitativeValue", minValue: 500, maxValue: 999, unitText: "pcs" },
      { "@type": "QuantitativeValue", minValue: 1000, maxValue: 4999, unitText: "pcs" },
      { "@type": "QuantitativeValue", minValue: 5000, unitText: "pcs" },
    ]);
    expect(o.offers[2].price).toBe("9.00");
    expect(o.seller.name).toBe("Acme Packs");
  });
});
