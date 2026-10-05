// Quantity price slabs + trade info (PDP). Slabs are versioned inside the listing snapshot and projected to LIVE.
import { z } from "zod";

/** One slab: from `minQty` units upward the price is `pricePaise` per unit (integer paise, safe-integer number at module boundaries). */
export interface PriceTier {
  minQty: number;
  pricePaise: number;
}

/** Optional trade facts shown on the product page. A missing field is simply not rendered. */
export interface TradeInfo {
  leadTimeDays?: number | null;
  packaging?: string | null;
  sampleAvailable?: boolean;
  samplePricePaise?: number | null;
  /** Sample workflow (docs/design/samples.md): most units one sample request may ask for, days from accepting to dispatch, minimum buyer verification tier (0-3). */
  sampleMaxQty?: number | null;
  sampleDispatchDays?: number | null;
  sampleMinBuyerTier?: number | null;
  /** units (the listing's price unit) per month */
  supplyCapacityPerMonth?: number | null;
  paymentTerms?: string | null;
  certifications?: string[];
}

export const MAX_TIERS = 8;

export const priceTierSchema = z.object({
  minQty: z.number().int().min(1).max(2_000_000_000),
  pricePaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const tradeInfoSchema = z.object({
  leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
  packaging: z.string().trim().max(500).nullable().optional(),
  sampleAvailable: z.boolean().optional(),
  samplePricePaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  sampleMaxQty: z.number().int().min(1).max(1_000_000).nullable().optional(),
  sampleDispatchDays: z.number().int().min(0).max(90).nullable().optional(),
  sampleMinBuyerTier: z.number().int().min(0).max(3).nullable().optional(),
  supplyCapacityPerMonth: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  paymentTerms: z.string().trim().max(500).nullable().optional(),
  certifications: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
});

/**
 * Slab rules: strictly ascending minQty, first slab >= MOQ (>= 1 without one), prices non-increasing.
 * Returns human-readable problems (empty = valid).
 */
export function validatePriceTiers(tiers: readonly PriceTier[], moq: number | null): string[] {
  const errs: string[] = [];
  if (tiers.length > MAX_TIERS) errs.push(`At most ${MAX_TIERS} price tiers`);
  const floor = moq ?? 1;
  tiers.forEach((t, i) => {
    const prev = tiers[i - 1];
    if (i === 0 && t.minQty < floor) errs.push(`First tier must start at or above the minimum order (${floor})`);
    if (prev && t.minQty <= prev.minQty) errs.push(`Tier ${i + 1}: quantity must be greater than the previous tier (${prev.minQty})`);
    if (prev && t.pricePaise > prev.pricePaise) errs.push(`Tier ${i + 1}: price must not be higher than the previous tier`);
  });
  return errs;
}

/** Reads stored JSON back into slabs, dropping malformed rows (order is validated on write, not repaired here). */
export function parsePriceTiers(raw: unknown): PriceTier[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceTier[] = [];
  for (const r of raw) {
    const p = priceTierSchema.safeParse(r);
    if (p.success) out.push({ minQty: p.data.minQty, pricePaise: p.data.pricePaise });
  }
  return out;
}

/** Compact trade info: only present fields, so views/snapshots/diffs stay stable. */
export function compactTrade(t: TradeInfo | null | undefined): TradeInfo {
  const out: TradeInfo = {};
  if (!t) return out;
  if (t.leadTimeDays != null) out.leadTimeDays = t.leadTimeDays;
  if (t.packaging) out.packaging = t.packaging;
  if (t.sampleAvailable) out.sampleAvailable = true;
  if (t.sampleAvailable && t.samplePricePaise != null) out.samplePricePaise = t.samplePricePaise;
  if (t.sampleAvailable && t.sampleMaxQty != null) out.sampleMaxQty = t.sampleMaxQty;
  if (t.sampleAvailable && t.sampleDispatchDays != null) out.sampleDispatchDays = t.sampleDispatchDays;
  if (t.sampleAvailable && t.sampleMinBuyerTier) out.sampleMinBuyerTier = t.sampleMinBuyerTier;
  if (t.supplyCapacityPerMonth != null) out.supplyCapacityPerMonth = t.supplyCapacityPerMonth;
  if (t.paymentTerms) out.paymentTerms = t.paymentTerms;
  if (t.certifications?.length) out.certifications = t.certifications;
  return out;
}

export function parseTrade(raw: unknown): TradeInfo {
  const p = tradeInfoSchema.safeParse(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
  return p.success ? compactTrade(p.data) : {};
}

/** Trade info from the authoring row's scalar columns. */
export function tradeOfRow(l: {
  leadTimeDays: number | null;
  packaging: string | null;
  sampleAvailable: boolean;
  samplePricePaise: bigint | null;
  sampleMaxQty?: number | null;
  sampleDispatchDays?: number | null;
  sampleMinBuyerTier?: number | null;
  supplyCapacityPerMonth: number | null;
  paymentTerms: string | null;
  certifications: string[];
}): TradeInfo {
  return compactTrade({
    leadTimeDays: l.leadTimeDays,
    packaging: l.packaging,
    sampleAvailable: l.sampleAvailable,
    samplePricePaise: l.samplePricePaise === null ? null : Number(l.samplePricePaise),
    sampleMaxQty: l.sampleMaxQty ?? null,
    sampleDispatchDays: l.sampleDispatchDays ?? null,
    sampleMinBuyerTier: l.sampleMinBuyerTier ?? null,
    supplyCapacityPerMonth: l.supplyCapacityPerMonth,
    paymentTerms: l.paymentTerms,
    certifications: l.certifications,
  });
}
