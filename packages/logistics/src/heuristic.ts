// Deterministic default provider: zone x weight-slab rate card, volumetric weight, mode by weight, fuel surcharge, GST.
// Pure (the card is passed in): same input, same output. No network, no clock.
import { DEFAULT_RATE_CARD, type RateCard } from "./card";
import { classifyLane } from "./zones";
import type { AssumptionCode, FreightEstimate, FreightMode, FreightRateProvider, FreightRequest, Zone } from "./types";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface Weights {
  actualKg: number;
  volumetricKg: number | null;
  assumptions: AssumptionCode[];
}

/** Actual weight (quantity x unit weight, default when unknown) and volumetric weight from the pack dimensions, if all three are known. */
export function shipmentWeights(req: FreightRequest, card: RateCard, divisor: number): Weights {
  const assumptions: AssumptionCode[] = [];
  const qty = Math.max(1, Math.ceil(req.quantity));
  let unitG = req.unitWeightGrams ?? null;
  if (!unitG || unitG <= 0) {
    unitG = card.defaultUnitWeightGrams;
    assumptions.push("weight_default");
  }
  const actualKg = (unitG * qty) / 1000;
  const { unitLengthMm: l, unitWidthMm: w, unitHeightMm: h } = req;
  let volumetricKg: number | null = null;
  if (l && w && h && l > 0 && w > 0 && h > 0) volumetricKg = (((l * w * h) / 1000) * qty) / divisor; // mm3 -> cm3
  else assumptions.push("dims_missing");
  return { actualKg, volumetricKg, assumptions };
}

/** Mode from the parcel-priced chargeable weight; thresholds are on the card. */
export function pickMode(chargeableKg: number, card: RateCard): FreightMode {
  if (chargeableKg <= card.parcelMaxKg) return "parcel";
  if (chargeableKg <= card.ltlMaxKg) return "ltl";
  return "ftl";
}

export function estimateWithCard(req: FreightRequest, card: RateCard = DEFAULT_RATE_CARD, providerId = "heuristic"): FreightEstimate {
  const lane = classifyLane(req.originPincode, req.destinationPincode);
  const zone: Zone = lane.zone;
  const assumptions: AssumptionCode[] = [];
  if (!lane.originKnown) assumptions.push("origin_unknown");
  if (!lane.destinationKnown) assumptions.push("destination_unknown");

  // Weigh once with the parcel divisor to choose the mode, then re-weigh with the mode's own divisor.
  const probe = shipmentWeights(req, card, card.parcelVolumetricDivisor);
  const probeCharge = Math.max(probe.actualKg, probe.volumetricKg ?? 0);
  const mode = pickMode(probeCharge, card);
  const divisor = mode === "parcel" ? card.parcelVolumetricDivisor : card.ltlVolumetricDivisor;
  const wts = mode === "parcel" ? probe : shipmentWeights(req, card, divisor);
  for (const a of wts.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
  let chargeable = Math.max(wts.actualKg, wts.volumetricKg ?? 0);
  if (wts.volumetricKg !== null && wts.volumetricKg > wts.actualKg) assumptions.push("volumetric_applied");

  let base: number;
  let vehicles = 1;
  let transitDays;
  if (mode === "parcel") {
    const slabs = [...card.parcel.slabs].sort((a, b) => a.upToKg - b.upToKg);
    const slab = slabs.find((s) => s.upToKg >= chargeable) ?? slabs[slabs.length - 1]!;
    base = slab.rates[zone];
    transitDays = card.parcel.transitDays[zone];
  } else if (mode === "ltl") {
    chargeable = Math.max(chargeable, card.ltl.minChargeableKg);
    base = Math.max(card.ltl.minChargePaise[zone], Math.round(chargeable * card.ltl.perKgPaise[zone]));
    transitDays = card.ltl.transitDays[zone];
  } else {
    const vs = [...card.ftl.vehicles].sort((a, b) => a.capacityKg - b.capacityKg);
    const fit = vs.find((v) => v.capacityKg >= chargeable);
    if (fit) base = fit.rates[zone];
    else {
      const biggest = vs[vs.length - 1]!;
      vehicles = Math.ceil(chargeable / biggest.capacityKg);
      base = biggest.rates[zone] * vehicles;
      assumptions.push("multi_vehicle");
    }
    transitDays = card.ftl.transitDays[zone];
  }

  const withFuel = base + Math.round((base * card.fuelSurchargeBps) / 10_000);
  const low = Math.round((withFuel * (10_000 + card.lowSpreadBps)) / 10_000);
  const high = Math.round((withFuel * (10_000 + card.highSpreadBps)) / 10_000);
  const gst = (n: number) => Math.round((n * card.gstBps) / 10_000);
  assumptions.push("excludes_pickup_delivery_extras");
  return {
    provider: providerId,
    mode,
    zone,
    originState: lane.originState,
    destinationState: lane.destinationState,
    actualWeightKg: round2(wts.actualKg),
    volumetricWeightKg: wts.volumetricKg === null ? null : round2(wts.volumetricKg),
    chargeableWeightKg: round2(chargeable),
    vehicles,
    lowPaise: low,
    highPaise: high,
    midPaise: withFuel,
    gstLowPaise: gst(low),
    gstHighPaise: gst(high),
    gstRateBps: card.gstBps,
    fuelSurchargeBps: card.fuelSurchargeBps,
    transitDays: { ...transitDays },
    assumptions,
    estimateOnly: true,
  };
}

/** The default provider over a card source (DB-backed in production, injectable in tests). */
export function heuristicProvider(loadCard: () => Promise<RateCard> | RateCard = () => DEFAULT_RATE_CARD): FreightRateProvider {
  return { id: "heuristic", async estimate(req) { return estimateWithCard(req, await loadCard()); } };
}
