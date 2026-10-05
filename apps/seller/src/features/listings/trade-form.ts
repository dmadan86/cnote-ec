// Pure parsing of the listing form's quantity-tier rows and trade-info fields (no server imports: unit-testable).
import { rupeesToPaise } from "@cnote/core";
import type { PriceTier, TradeInfo } from "@cnote/catalogue";

export type TierParse = { tiers: PriceTier[]; badRows: number[] };

const blank = (s: string) => s.trim() === "";

/**
 * Rows arrive as parallel lists (`tierMinQty`, `tierPrice`, in rupees). Rows where both are blank are ignored;
 * a half-filled or non-numeric row is reported (1-based) so the form can point at it. Money is converted once, to paise.
 */
export function parseTierRows(minQtys: string[], prices: string[]): TierParse {
  const tiers: PriceTier[] = [];
  const badRows: number[] = [];
  const n = Math.max(minQtys.length, prices.length);
  for (let i = 0; i < n; i++) {
    const q = minQtys[i] ?? "";
    const p = prices[i] ?? "";
    if (blank(q) && blank(p)) continue;
    const qty = Number(q);
    const price = Number(p);
    if (blank(q) || blank(p) || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(price) || price < 0) {
      badRows.push(i + 1);
      continue;
    }
    tiers.push({ minQty: qty, pricePaise: rupeesToPaise(price) });
  }
  return { tiers, badRows };
}

export interface TradeFields {
  leadTimeDays: string;
  packaging: string;
  sampleAvailable: boolean;
  samplePriceRupees: string;
  supplyCapacityPerMonth: string;
  paymentTerms: string;
  certifications: string;
  /** shipping facts per unit (freight estimator): grams and centimetres as typed; all optional */
  unitWeightGrams?: string;
  lengthCm?: string;
  widthCm?: string;
  heightCm?: string;
}

/** Returns the trade info for the catalogue plus whether any numeric field was not a whole non-negative number. */
export function parseTradeFields(f: TradeFields): { trade: TradeInfo; invalid: boolean; shippingInvalid: boolean } {
  let invalid = false;
  let shippingInvalid = false;
  const whole = (s: string): number | null => {
    if (blank(s)) return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) {
      invalid = true;
      return null;
    }
    return n;
  };
  const samplePrice = blank(f.samplePriceRupees) ? null : Number(f.samplePriceRupees);
  if (samplePrice !== null && (!Number.isFinite(samplePrice) || samplePrice < 0)) invalid = true;
  const capacity = whole(f.supplyCapacityPerMonth);
  const positiveInt = (s: string | undefined, scale = 1): number | null => {
    if (!s || blank(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
      shippingInvalid = true;
      return null;
    }
    return Math.max(1, Math.round(n * scale));
  };
  const weight = positiveInt(f.unitWeightGrams);
  if (weight !== null && !Number.isInteger(Number(f.unitWeightGrams))) shippingInvalid = true;
  const trade: TradeInfo = {
    leadTimeDays: whole(f.leadTimeDays),
    packaging: f.packaging.trim() || null,
    sampleAvailable: f.sampleAvailable,
    samplePricePaise: f.sampleAvailable && samplePrice !== null && Number.isFinite(samplePrice) && samplePrice >= 0 ? rupeesToPaise(samplePrice) : null,
    supplyCapacityPerMonth: capacity === 0 ? null : capacity,
    paymentTerms: f.paymentTerms.trim() || null,
    certifications: f.certifications.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12),
    unitWeightGrams: weight,
    unitLengthMm: positiveInt(f.lengthCm, 10),
    unitWidthMm: positiveInt(f.widthCm, 10),
    unitHeightMm: positiveInt(f.heightCm, 10),
  };
  return { trade, invalid, shippingInvalid };
}
