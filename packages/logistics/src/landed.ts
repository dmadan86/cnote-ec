// Landed cost = goods + goods GST + freight + GST on freight. Pure integer-paise arithmetic; unknowns stay null, never guessed.

export interface LandedInput {
  /** goods subtotal (unit price x quantity), paise */
  goodsPaise: number;
  /** goods GST rate in basis points when stated as EXTRA; null/0 when included or unknown */
  goodsGstBps?: number | null;
  /** freight before GST, paise; null = unknown */
  freightPaise: number | null;
  freightGstBps: number;
}

export interface LandedCost {
  goodsPaise: number;
  goodsGstPaise: number;
  freightPaise: number | null;
  freightGstPaise: number | null;
  totalPaise: number;
  /** false when freight is unknown, so the total is goods (+GST) only */
  complete: boolean;
}

export function landedCost(i: LandedInput): LandedCost {
  const goodsGst = i.goodsGstBps ? Math.round((i.goodsPaise * i.goodsGstBps) / 10_000) : 0;
  const fGst = i.freightPaise === null ? null : Math.round((i.freightPaise * i.freightGstBps) / 10_000);
  return {
    goodsPaise: i.goodsPaise,
    goodsGstPaise: goodsGst,
    freightPaise: i.freightPaise,
    freightGstPaise: fGst,
    totalPaise: i.goodsPaise + goodsGst + (i.freightPaise ?? 0) + (fGst ?? 0),
    complete: i.freightPaise !== null,
  };
}

/** GST rate assumed on GOODS only when a seller says "GST extra" without a rate (quotes carry a flag, not a rate). Always labelled as assumed. */
export const ASSUMED_GOODS_GST_BPS = 1800;

export interface QuoteLandedInput {
  /** unit price x quantity, excluding delivery, paise */
  goodsPaise: number;
  /** seller's flag: true = prices include GST, false = GST extra, null = not stated */
  gstIncluded: boolean | null;
  /** seller's stated delivery charge for the whole quantity, paise (0 for ex-works / buyer pickup); null = not stated */
  deliveryChargePaise: number | null;
  /** freight estimate (before GST), used ONLY when the seller did not state a charge */
  estimate: { lowPaise: number; highPaise: number } | null;
  freightGstBps: number;
}

export interface QuoteLanded {
  lowPaise: number;
  highPaise: number;
  freightSource: "quoted" | "estimated" | "none";
  /** goods GST added at ASSUMED_GOODS_GST_BPS because the seller said GST is extra */
  goodsGstPaise: number;
  goodsGstAssumed: boolean;
  /** GST not stated by the seller: not added, flagged */
  gstUnknown: boolean;
  /** no stated charge and no estimate: total is goods (+GST) only */
  complete: boolean;
}

/** Landed cost of one quote: goods + goods GST (only when stated extra) + freight (seller's charge, else the estimate range) + GST on estimated freight. */
export function quoteLanded(i: QuoteLandedInput): QuoteLanded {
  const goodsGst = i.gstIncluded === false ? Math.round((i.goodsPaise * ASSUMED_GOODS_GST_BPS) / 10_000) : 0;
  const base = i.goodsPaise + goodsGst;
  const common = { goodsGstPaise: goodsGst, goodsGstAssumed: i.gstIncluded === false, gstUnknown: i.gstIncluded === null };
  if (i.deliveryChargePaise != null) {
    // a stated charge is the seller's own figure: taken as is (GST on it only if the seller said GST is extra)
    const charge = i.gstIncluded === false ? i.deliveryChargePaise + Math.round((i.deliveryChargePaise * i.freightGstBps) / 10_000) : i.deliveryChargePaise;
    return { ...common, lowPaise: base + charge, highPaise: base + charge, freightSource: "quoted", complete: true };
  }
  if (i.estimate) {
    const withGst = (n: number) => n + Math.round((n * i.freightGstBps) / 10_000);
    return { ...common, lowPaise: base + withGst(i.estimate.lowPaise), highPaise: base + withGst(i.estimate.highPaise), freightSource: "estimated", complete: true };
  }
  return { ...common, lowPaise: base, highPaise: base, freightSource: "none", complete: false };
}
