import { randomUUID } from "node:crypto";
import type { ListingView } from "@cnote/catalogue";

export function listing(over: Partial<ListingView> & { sellerBusinessId: string }): ListingView {
  return {
    id: randomUUID(), category: { id: randomUUID(), slug: "steel-pipes", name: "Steel pipes" }, title: "MS ERW pipe 2 inch", description: "Mild steel ERW pipe to IS 1239",
    attributes: { grade: "IS 1239", gsm: 3 }, pricePaise: 8450, priceUnit: "kg", moq: 50, moqUnit: "kg", hsn: "7306", language: "en", imageUrls: ["https://img.example/p1.jpg"],
    aiGenerated: false, status: "published", moderationStatus: "approved", moderationReason: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    seller: { name: "Sharma Steels", city: "Jamshedpur", state: "Jharkhand", verificationTier: 2, trustScore: 80, badgeActive: true },
    ...over,
  };
}
