// Pure, framework-free rules for ADR-014. Everything a model proposes passes through these SERVER-SIDE checks; a proposal
// outside bounds is rejected even if the model produced it. No I/O here so the rules are property-testable.

export interface PriceTier { minQty: number; pricePaise: number }

/** Counters below this fraction of the quoted price are refused as lowball (protects the buyer's reputation and the seller's inbox). */
export const MIN_COUNTER_RATIO = 0.5;
/** Default private floor as a fraction of the base price when seeding from a live listing: the agent never discounts unless the seller lowers it. */
export const DEFAULT_FLOOR_RATIO = 1;

export interface BoundsResult { ok: boolean; violations: string[] }
const result = (violations: string[]): BoundsResult => ({ ok: violations.length === 0, violations });
const isPaise = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function parseTiers(raw: unknown): PriceTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is PriceTier => !!t && typeof t === "object" && Number.isSafeInteger((t as PriceTier).minQty) && Number.isSafeInteger((t as PriceTier).pricePaise))
    .map((t) => ({ minQty: t.minQty, pricePaise: t.pricePaise }))
    .sort((a, b) => a.minQty - b.minQty);
}

/** Problems with a price book entry (empty = valid). Tiers must ascend in quantity and never rise in price; nothing may sit below the floor. */
export function priceBookProblems(b: { basePricePaise: number; floorPricePaise: number; tiers: PriceTier[]; moq?: number | null; leadTimeDays?: number; validityDays?: number; gstPercent?: number | null }): string[] {
  const p: string[] = [];
  if (!isPaise(b.basePricePaise)) p.push("Base price must be a positive amount.");
  if (!isPaise(b.floorPricePaise)) p.push("Floor price must be a positive amount.");
  if (isPaise(b.basePricePaise) && isPaise(b.floorPricePaise) && b.floorPricePaise > b.basePricePaise) p.push("Floor price cannot be above the base price.");
  let prevQty = 0;
  let prevPrice = b.basePricePaise;
  for (const t of b.tiers) {
    if (!Number.isSafeInteger(t.minQty) || t.minQty < 2) p.push("Each price break needs a quantity of 2 or more.");
    else if (t.minQty <= prevQty) p.push("Price breaks must have increasing quantities.");
    if (!isPaise(t.pricePaise)) p.push("Each price break needs a positive price.");
    else {
      if (t.pricePaise > prevPrice) p.push("A higher quantity cannot cost more per unit.");
      if (isPaise(b.floorPricePaise) && t.pricePaise < b.floorPricePaise) p.push("A price break is below your floor price.");
    }
    prevQty = t.minQty;
    if (isPaise(t.pricePaise)) prevPrice = t.pricePaise;
  }
  if (b.moq != null && (!Number.isSafeInteger(b.moq) || b.moq < 1)) p.push("MOQ must be 1 or more.");
  if (b.leadTimeDays != null && (!Number.isSafeInteger(b.leadTimeDays) || b.leadTimeDays < 0 || b.leadTimeDays > 365)) p.push("Lead time must be 0 to 365 days.");
  if (b.validityDays != null && (!Number.isSafeInteger(b.validityDays) || b.validityDays < 1 || b.validityDays > 90)) p.push("Validity must be 1 to 90 days.");
  if (b.gstPercent != null && (!Number.isSafeInteger(b.gstPercent) || b.gstPercent < 0 || b.gstPercent > 40)) p.push("GST must be 0 to 40 percent.");
  return [...new Set(p)];
}

/** Seller side: a quote price may never be below the seller's private floor. */
export function checkSellerQuote(
  q: { pricePaise: number | null; quantity: number; leadTimeDays?: number | null },
  b: { floorPricePaise: number; minLeadTimeDays?: number | null },
): BoundsResult {
  const v: string[] = [];
  if (q.pricePaise === null) v.push("No price.");
  else if (!isPaise(q.pricePaise)) v.push("Price must be a positive whole number of paise.");
  else if (q.pricePaise < b.floorPricePaise) v.push("Price is below your floor price.");
  if (!Number.isSafeInteger(q.quantity) || q.quantity < 1) v.push("Quantity must be 1 or more.");
  if (b.minLeadTimeDays != null && q.leadTimeDays != null && q.leadTimeDays < b.minLeadTimeDays) v.push("Lead time is shorter than your price book allows.");
  return result(v);
}

export interface BuyerBoundsInput { targetPricePaise: number | null; ceilingPricePaise: number | null; maxLeadTimeDays: number | null }

/** Buyer-bounds validation when the buyer sets them. */
export function buyerBoundsProblems(b: BuyerBoundsInput): string[] {
  const p: string[] = [];
  if (b.targetPricePaise != null && !isPaise(b.targetPricePaise)) p.push("Target price must be a positive amount.");
  if (b.ceilingPricePaise != null && !isPaise(b.ceilingPricePaise)) p.push("Maximum price must be a positive amount.");
  if (b.targetPricePaise != null && b.ceilingPricePaise != null && b.targetPricePaise > b.ceilingPricePaise) p.push("Target price cannot be above your maximum price.");
  if (b.maxLeadTimeDays != null && (!Number.isSafeInteger(b.maxLeadTimeDays) || b.maxLeadTimeDays < 1 || b.maxLeadTimeDays > 365)) p.push("Maximum delivery time must be 1 to 365 days.");
  return p;
}

/** Buyer side: a counter must undercut the quote, stay within the buyer's ceiling and delivery limit, and not be a lowball. */
export function checkBuyerCounter(
  c: { pricePaise: number; leadTimeDays: number | null },
  quote: { pricePaise: number },
  b: BuyerBoundsInput,
): BoundsResult {
  const v: string[] = [];
  if (!isPaise(c.pricePaise)) v.push("Price must be a positive whole number of paise.");
  else {
    if (c.pricePaise >= quote.pricePaise) v.push("A counter must be below the quoted price.");
    if (b.ceilingPricePaise != null && c.pricePaise > b.ceilingPricePaise) v.push("Price is above your maximum price.");
    if (c.pricePaise < Math.ceil(quote.pricePaise * MIN_COUNTER_RATIO)) v.push("Price is more than 50% below the quote, which suppliers rarely accept.");
  }
  if (c.leadTimeDays != null) {
    if (!Number.isSafeInteger(c.leadTimeDays) || c.leadTimeDays < 1) v.push("Delivery time must be 1 day or more.");
    else if (b.maxLeadTimeDays != null && c.leadTimeDays > b.maxLeadTimeDays) v.push("Delivery time is longer than your limit.");
  }
  return result(v);
}

/**
 * Deterministic counter used when the model's proposal is rejected (or unusable): aim for the buyer's target (else 5% off),
 * clamped into the allowed range. Returns null when no valid counter exists (quote already at/below the floor of the range).
 */
export function fallbackCounter(quote: { pricePaise: number; leadTimeDays: number | null }, b: BuyerBoundsInput): { pricePaise: number; leadTimeDays: number | null } | null {
  const hi = Math.min(quote.pricePaise - 1, b.ceilingPricePaise ?? Number.MAX_SAFE_INTEGER);
  const lo = Math.ceil(quote.pricePaise * MIN_COUNTER_RATIO);
  if (!(hi >= lo) || hi < 1) return null;
  const pref = b.targetPricePaise ?? Math.round(quote.pricePaise * 0.95);
  const pricePaise = Math.max(lo, Math.min(hi, pref));
  const leadTimeDays = b.maxLeadTimeDays != null && quote.leadTimeDays != null && quote.leadTimeDays > b.maxLeadTimeDays ? b.maxLeadTimeDays : null;
  return { pricePaise, leadTimeDays };
}

// ---------------------------------------------------------------- comparison maths
export interface LandedInput {
  pricePaise: number;
  quantity: number;
  deliveryChargePaise: number | null;
  deliveryIncluded: boolean | null;
  gstPercent: number | null;
  gstIncluded: boolean | null;
}
export interface Landed { landedPaise: number; complete: boolean; assumptions: ("delivery_unknown" | "gst_unknown")[] }

/** Landed price per unit: quoted price + delivery per unit, plus GST when it is stated as extra. Unknowns are flagged, never guessed. */
export function landedPerUnit(i: LandedInput): Landed {
  const assumptions: Landed["assumptions"] = [];
  let perUnit = i.pricePaise;
  if (i.deliveryChargePaise != null && i.quantity > 0) perUnit += i.deliveryChargePaise / i.quantity;
  else if (i.deliveryIncluded !== true) assumptions.push("delivery_unknown");
  if (i.gstIncluded === false && i.gstPercent != null) perUnit *= 1 + i.gstPercent / 100;
  else if (i.gstIncluded !== true) assumptions.push("gst_unknown");
  return { landedPaise: Math.round(perUnit), complete: assumptions.length === 0, assumptions };
}

export interface RankRow { key: string; landedPaise: number; leadTimeDays: number | null; verificationTier: number; expired: boolean }
export const VALUE_WEIGHTS = { price: 0.6, lead: 0.25, trust: 0.15 } as const;

/** Highlights: lowest landed price, fastest delivery, and a weighted best value (price 60 / lead time 25 / trust tier 15). Expired quotes never win. */
export function rankQuotes(rows: RankRow[]): { bestPrice: string | null; fastest: string | null; bestValue: string | null } {
  const live = rows.filter((r) => !r.expired);
  if (live.length === 0) return { bestPrice: null, fastest: null, bestValue: null };
  const bestPrice = [...live].sort((a, b) => a.landedPaise - b.landedPaise || a.key.localeCompare(b.key))[0]!.key;
  const withLead = live.filter((r) => r.leadTimeDays != null);
  const fastest = withLead.length ? [...withLead].sort((a, b) => a.leadTimeDays! - b.leadTimeDays! || a.landedPaise - b.landedPaise || a.key.localeCompare(b.key))[0]!.key : null;
  const prices = live.map((r) => r.landedPaise);
  const pMin = Math.min(...prices), pMax = Math.max(...prices);
  const leads = withLead.map((r) => r.leadTimeDays!);
  const lMin = Math.min(...leads), lMax = Math.max(...leads);
  const score = (r: RankRow) => {
    const p = pMax === pMin ? 1 : 1 - (r.landedPaise - pMin) / (pMax - pMin);
    const l = r.leadTimeDays == null ? 0.5 : lMax === lMin ? 1 : 1 - (r.leadTimeDays - lMin) / (lMax - lMin);
    const t = Math.max(0, Math.min(3, r.verificationTier)) / 3;
    return VALUE_WEIGHTS.price * p + VALUE_WEIGHTS.lead * l + VALUE_WEIGHTS.trust * t;
  };
  const bestValue = [...live].sort((a, b) => score(b) - score(a) || a.landedPaise - b.landedPaise || a.key.localeCompare(b.key))[0]!.key;
  return { bestPrice, fastest, bestValue };
}

// ---------------------------------------------------------------- edit distance (acceptance metrics)
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const A = a.slice(0, 2000), B = b.slice(0, 2000);
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[B.length]!;
}

export interface DraftFields { pricePaise: number; quantity: number; unit: string; leadTimeDays: number | null; shippingTerms: string | null; validUntil: string | null; notes: string | null }
export function editStats(original: DraftFields, final: DraftFields): { editedFields: number; priceDeltaPct: number | null; notesEditDistance: number } {
  const keys: (keyof DraftFields)[] = ["pricePaise", "quantity", "unit", "leadTimeDays", "shippingTerms", "validUntil", "notes"];
  const editedFields = keys.filter((k) => (original[k] ?? null) !== (final[k] ?? null)).length;
  const priceDeltaPct = original.pricePaise > 0 ? ((final.pricePaise - original.pricePaise) / original.pricePaise) * 100 : null;
  return { editedFields, priceDeltaPct, notesEditDistance: levenshtein(original.notes ?? "", final.notes ?? "") };
}
