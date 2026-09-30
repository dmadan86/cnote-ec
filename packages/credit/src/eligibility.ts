// Eligibility rules (pure). ADR-019: credit only on escrowed orders; GST-verified; score above the partner-agreed floor.
import { creditConfig } from "./config";
import { BAND_LIMITS, type Band, type CreditFeatures } from "./model";
import type { EscrowFacts, Product } from "./types";

export type IneligibleReason =
  | "no_consent" | "gst_not_verified" | "gst_inactive" | "score_too_low" | "not_your_order" | "escrow_frozen" | "escrow_not_funded" | "escrow_already_funded"
  | "escrow_closed" | "amount_too_small" | "amount_exceeds_limit";

export interface Eligibility { eligible: boolean; reasons: IneligibleReason[]; maxAmountPaise: number }

export interface EligibilityInput {
  product: Product;
  businessId: string;
  escrow: EscrowFacts;
  score: { score: number; band: Band };
  features: Pick<CreditFeatures, "gstVerified" | "gstActive">;
  sellerNetPaise: number;
  requestedAmountPaise?: number;
  env?: NodeJS.ProcessEnv;
}

/** The most that can be financed for this order at this band (0 when the band does not qualify). */
export function maxAmount(product: Product, band: Band, escrow: Pick<EscrowFacts, "amountPaise">, sellerNetPaise: number): number {
  const lim = BAND_LIMITS[band];
  return product === "invoice_financing" ? Math.floor((sellerNetPaise * lim.advanceBps) / 10_000) : Math.min(escrow.amountPaise, lim.bnplCapPaise);
}

export function assessEligibility(i: EligibilityInput): Eligibility {
  const cfg = creditConfig(i.env);
  const reasons: IneligibleReason[] = [];
  const isSeller = i.escrow.sellerBusinessId === i.businessId;
  const isBuyer = i.escrow.buyerBusinessId === i.businessId;
  if ((i.product === "invoice_financing" && !isSeller) || (i.product === "bnpl" && !isBuyer)) reasons.push("not_your_order");
  if (!i.features.gstVerified) reasons.push("gst_not_verified");
  else if (!i.features.gstActive) reasons.push("gst_inactive");
  if (i.score.score < (i.product === "bnpl" ? cfg.bnplMinScore : cfg.minScore)) reasons.push("score_too_low");
  if (i.escrow.frozen) reasons.push("escrow_frozen");
  if (i.product === "invoice_financing") {
    if (i.escrow.status !== "funded") reasons.push("escrow_not_funded");
  } else if (i.escrow.status !== "created" && i.escrow.status !== "awaiting_funding") {
    reasons.push(i.escrow.status === "funded" ? "escrow_already_funded" : "escrow_closed");
  }
  const max = maxAmount(i.product, i.score.band, i.escrow, i.sellerNetPaise);
  if (max < cfg.minAmountPaise) reasons.push("amount_too_small");
  if (i.requestedAmountPaise !== undefined) {
    if (i.requestedAmountPaise < cfg.minAmountPaise && !reasons.includes("amount_too_small")) reasons.push("amount_too_small");
    if (i.requestedAmountPaise > max) reasons.push("amount_exceeds_limit");
  }
  const uniq = [...new Set(reasons)];
  return { eligible: uniq.length === 0, reasons: uniq, maxAmountPaise: uniq.includes("not_your_order") ? 0 : max };
}

export const TENORS: Record<Product, readonly number[]> = { invoice_financing: [15, 30, 45, 60], bnpl: [30, 60, 90] };
export const DEFAULT_TENOR_DAYS = 30;
