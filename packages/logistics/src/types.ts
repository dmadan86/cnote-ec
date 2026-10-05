// Freight estimator contracts (docs/design/freight-estimator.md). Estimate only: the platform never books or owns logistics.

export const ZONES = ["local", "intra_state", "metro", "regional", "national", "special"] as const;
/** How far apart two PINs are, for pricing. `special` = North-East, J&K, Ladakh and the island territories. */
export type Zone = (typeof ZONES)[number];

export const MODES = ["parcel", "ltl", "ftl"] as const;
/** parcel = courier; ltl = part-truck / surface cargo; ftl = full truck. */
export type FreightMode = (typeof MODES)[number];

/** Assumption codes shown to the buyer/seller (translated in the UI, never free text from a provider). */
export type AssumptionCode =
  | "weight_default" // no unit weight on the listing: a default per-unit weight was used
  | "dims_missing" // no dimensions: actual weight only, no volumetric weight
  | "origin_unknown" // seller PIN unknown or unmapped: treated as a national lane
  | "destination_unknown"
  | "volumetric_applied" // volumetric weight exceeded actual weight and was charged
  | "multi_vehicle" // more than one truck needed
  | "provider_fallback" // a live rate API was unavailable or does not cover this mode, the default card was used
  | "excludes_pickup_delivery_extras"; // no loading, unloading, octroi or last-mile surcharges

export interface FreightRequest {
  originPincode: string | null;
  destinationPincode: string;
  /** units (the listing's price unit) being shipped */
  quantity: number;
  /** packed weight of ONE unit, grams */
  unitWeightGrams?: number | null;
  /** outer pack dimensions of one unit, millimetres; a stack of units is modelled as quantity x single volume */
  unitLengthMm?: number | null;
  unitWidthMm?: number | null;
  unitHeightMm?: number | null;
}

export interface Range {
  min: number;
  max: number;
}

export interface FreightEstimate {
  /** provider that produced the numbers (`heuristic`, `shiprocket`, `delhivery`) */
  provider: string;
  mode: FreightMode;
  zone: Zone;
  originState: string | null;
  destinationState: string | null;
  actualWeightKg: number;
  volumetricWeightKg: number | null;
  chargeableWeightKg: number;
  vehicles: number;
  /** freight before GST, paise (integer): the range a buyer can expect */
  lowPaise: number;
  highPaise: number;
  /** mid-point, what "Suggest freight" fills in */
  midPaise: number;
  /** 18% (card value) GST on freight, paise, for the low / high ends */
  gstLowPaise: number;
  gstHighPaise: number;
  gstRateBps: number;
  fuelSurchargeBps: number;
  transitDays: Range;
  assumptions: AssumptionCode[];
  /** always true: the final freight is quoted by the seller */
  estimateOnly: true;
}

/** The port. Implementations must not throw for "no rate": return null and the caller falls back to the default card. */
export interface FreightRateProvider {
  readonly id: string;
  estimate(req: FreightRequest): Promise<FreightEstimate | null>;
}

export const MAX_QUANTITY = 1_000_000_000;
