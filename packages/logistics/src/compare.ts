// Landed cost per supplier for the buyer's quote comparison: goods + GST + freight (seller's charge, else an estimate).
// Estimates are only made for quotes that do not state a delivery charge and are not ex-works / buyer pickup.
import { getSellerShippingFacts } from "@cnote/catalogue";
import { getTrustProfiles } from "@cnote/identity";
import { estimateFreight, freightEstimatorEnabled } from "./index";
import { quoteLanded, type QuoteLanded } from "./landed";
import type { FreightEstimate } from "./types";

export interface QuoteLandedRequest {
  key: string;
  sellerBusinessId: string;
  quantity: number;
  goodsPaise: number;
  gstIncluded: boolean | null;
  deliveryChargePaise: number | null;
  deliveryTerms: string | null;
}

export interface QuoteLandedRow extends QuoteLanded {
  key: string;
  estimate: Pick<FreightEstimate, "lowPaise" | "highPaise" | "mode" | "transitDays" | "assumptions"> | null;
}

const NO_FREIGHT_TERMS = new Set(["ex_works", "buyer_pickup"]);

export async function landedForQuotes(rows: QuoteLandedRequest[], destinationPincode: string | null, categorySlug: string | null): Promise<Map<string, QuoteLandedRow>> {
  const out = new Map<string, QuoteLandedRow>();
  const enabled = freightEstimatorEnabled() && !!destinationPincode && /^[1-9]\d{5}$/.test(destinationPincode);
  const needs = rows.filter((r) => r.deliveryChargePaise == null && !NO_FREIGHT_TERMS.has(r.deliveryTerms ?? ""));
  const profiles = enabled && needs.length ? await getTrustProfiles([...new Set(needs.map((r) => r.sellerBusinessId))]).catch(() => new Map()) : new Map();
  const estimates = new Map<string, FreightEstimate>();
  if (enabled) {
    await Promise.all(needs.map(async (r) => {
      try {
        const facts = await getSellerShippingFacts(r.sellerBusinessId, categorySlug);
        estimates.set(r.key, await estimateFreight({
          originPincode: profiles.get(r.sellerBusinessId)?.pincode ?? null,
          destinationPincode: destinationPincode!,
          quantity: Math.max(1, Math.ceil(r.quantity)),
          unitWeightGrams: facts?.unitWeightGrams ?? null,
          unitLengthMm: facts?.unitLengthMm ?? null,
          unitWidthMm: facts?.unitWidthMm ?? null,
          unitHeightMm: facts?.unitHeightMm ?? null,
        }));
      } catch {
        /* no estimate for this supplier: shown as freight not stated */
      }
    }));
  }
  for (const r of rows) {
    const e = estimates.get(r.key) ?? null;
    const noFreight = NO_FREIGHT_TERMS.has(r.deliveryTerms ?? "");
    const landed = quoteLanded({
      goodsPaise: r.goodsPaise,
      gstIncluded: r.gstIncluded,
      deliveryChargePaise: r.deliveryChargePaise ?? (noFreight ? 0 : null),
      estimate: e ? { lowPaise: e.lowPaise, highPaise: e.highPaise } : null,
      freightGstBps: e?.gstRateBps ?? 1800,
    });
    out.set(r.key, { key: r.key, ...landed, estimate: e ? { lowPaise: e.lowPaise, highPaise: e.highPaise, mode: e.mode, transitDays: e.transitDays, assumptions: e.assumptions } : null });
  }
  return out;
}
