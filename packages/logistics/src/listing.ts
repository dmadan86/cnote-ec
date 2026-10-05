// Freight estimate for a PUBLIC listing, shared by the buyer web route and the public REST API. Reads the listing through
// the catalogue's public function and the seller's origin pincode through identity; the origin PIN itself is never returned.
import { DomainError } from "@cnote/core";
import { getPublicListing, type ListingView } from "@cnote/catalogue";
import { getTrustProfiles } from "@cnote/identity";
import { estimateFreight, freightEstimatorEnabled } from "./index";
import { landedCost, type LandedCost } from "./landed";
import type { FreightEstimate } from "./types";

export interface ListingFreightEstimate {
  listingId: string;
  quantity: number;
  unit: string | null;
  estimate: Omit<FreightEstimate, "originState" | "provider">;
  /** unit price at this quantity (tier-aware) and goods subtotal, paise; null when the listing has no price */
  unitPricePaise: number | null;
  goodsPaise: number | null;
  /** goods + freight (low/high) incl. GST on freight; product GST is NOT added (the listing states no rate) */
  landed: { low: LandedCost; high: LandedCost } | null;
}

/** Price per unit at `quantity`: the highest slab whose minQty <= quantity, else the base price. */
export function unitPriceAt(l: Pick<ListingView, "pricePaise" | "priceTiers">, quantity: number): number | null {
  let price = l.pricePaise;
  for (const t of l.priceTiers ?? []) if (quantity >= t.minQty) price = t.pricePaise;
  return price;
}

export async function estimateForListing(listingId: string, quantity: number, destinationPincode: string): Promise<ListingFreightEstimate> {
  if (!freightEstimatorEnabled()) throw new DomainError("not_found", "Freight estimates are not available.");
  const l = await getPublicListing(listingId);
  if (!l) throw new DomainError("not_found", "Listing not found");
  const profile = (await getTrustProfiles([l.sellerBusinessId])).get(l.sellerBusinessId) ?? null;
  const t = l.trade ?? {};
  const e = await estimateFreight({
    originPincode: profile?.pincode ?? null,
    destinationPincode,
    quantity,
    unitWeightGrams: t.unitWeightGrams ?? null,
    unitLengthMm: t.unitLengthMm ?? null,
    unitWidthMm: t.unitWidthMm ?? null,
    unitHeightMm: t.unitHeightMm ?? null,
  });
  const unitPricePaise = unitPriceAt(l, quantity);
  const goodsPaise = unitPricePaise == null ? null : unitPricePaise * quantity;
  const { originState: _o, provider: _p, ...estimate } = e;
  void _o;
  void _p;
  const landed = goodsPaise == null ? null : {
    low: landedCost({ goodsPaise, freightPaise: e.lowPaise, freightGstBps: e.gstRateBps }),
    high: landedCost({ goodsPaise, freightPaise: e.highPaise, freightGstBps: e.gstRateBps }),
  };
  return { listingId: l.id, quantity, unit: l.priceUnit, estimate, unitPricePaise, goodsPaise, landed };
}
