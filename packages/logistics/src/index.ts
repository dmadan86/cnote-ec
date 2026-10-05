// @cnote/logistics: freight ESTIMATOR (never booking, never owning logistics). docs/design/freight-estimator.md.
// A FreightRateProvider port with a deterministic default (zone x weight-slab rate card in the DB) and real Shiprocket /
// Delhivery adapters behind FREIGHT_PROVIDER. PUBLIC CONTRACT.
import { DomainError } from "@cnote/core";
import { z } from "zod";
import { delhiveryConfig, delhiveryProvider, shiprocketConfig, shiprocketProvider } from "./adapters";
import { estimateWithCard, heuristicProvider } from "./heuristic";
import { getActiveRateCard } from "./store";
import { MAX_QUANTITY, type FreightEstimate, type FreightRateProvider, type FreightRequest } from "./types";

export * from "./types";
export { DEFAULT_RATE_CARD, rateCardSchema, type RateCard } from "./card";
export { classifyLane, SPECIAL_STATES, METRO_PREFIXES, type Lane } from "./zones";
export { estimateWithCard, heuristicProvider, shipmentWeights, pickMode } from "./heuristic";
export { shiprocketProvider, delhiveryProvider, shiprocketConfig, delhiveryConfig, parseShiprocket, parseDelhivery, pinnedHttpJson, type HttpJson, type AdapterDeps } from "./adapters";
export { getActiveRateCard, listRateCards, saveRateCard, activateRateCard, resetRateCardToDefault, parseRateCardJson, type RateCardRow } from "./store";
export { estimateForListing, unitPriceAt, type ListingFreightEstimate } from "./listing";
export { landedCost, quoteLanded, ASSUMED_GOODS_GST_BPS, type LandedCost, type LandedInput, type QuoteLanded, type QuoteLandedInput } from "./landed";
export { landedForQuotes, type QuoteLandedRow, type QuoteLandedRequest } from "./compare";

export type ProviderName = "heuristic" | "shiprocket" | "delhivery";

export function providerName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const v = (env.FREIGHT_PROVIDER ?? "heuristic").trim().toLowerCase();
  if (v === "shiprocket" || v === "delhivery") return v;
  return "heuristic";
}

/** False turns the whole feature off (default on: it is estimate-only and read-only). */
export const freightEstimatorEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|false|no|off)$/i.test(env.FREIGHT_ESTIMATOR_ENABLED ?? "");

let override: FreightRateProvider | undefined;
/** Tests: replace the provider. Pass undefined to restore env selection. */
export function setFreightProvider(p: FreightRateProvider | undefined): void {
  override = p;
}

/**
 * The provider in force. A live provider without credentials is a hard error in production (validateSecrets refuses to boot
 * first) and degrades to the default card elsewhere, so a dev box without keys still shows estimates.
 */
export function getFreightProvider(env: NodeJS.ProcessEnv = process.env): FreightRateProvider {
  if (override) return override;
  const name = providerName(env);
  const loadCard = getActiveRateCard;
  if (name === "shiprocket") {
    const cfg = shiprocketConfig(env);
    if (cfg) return shiprocketProvider(cfg, { loadCard });
    if (env.NODE_ENV === "production") throw new Error("FREIGHT_PROVIDER=shiprocket needs SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD.");
  }
  if (name === "delhivery") {
    const cfg = delhiveryConfig(env);
    if (cfg) return delhiveryProvider(cfg, { loadCard });
    if (env.NODE_ENV === "production") throw new Error("FREIGHT_PROVIDER=delhivery needs DELHIVERY_API_TOKEN.");
  }
  return heuristicProvider(loadCard);
}

export const freightRequestSchema = z.object({
  originPincode: z.string().regex(/^[1-9]\d{5}$/).nullable().optional(),
  destinationPincode: z.string().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode."),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  unitWeightGrams: z.number().int().min(1).max(50_000_000).nullable().optional(),
  unitLengthMm: z.number().int().min(1).max(20_000).nullable().optional(),
  unitWidthMm: z.number().int().min(1).max(20_000).nullable().optional(),
  unitHeightMm: z.number().int().min(1).max(20_000).nullable().optional(),
});

/** Validates, asks the provider, and always returns an estimate (live provider failures fall back to the default card). */
export async function estimateFreight(input: unknown, provider: FreightRateProvider = getFreightProvider()): Promise<FreightEstimate> {
  const p = freightRequestSchema.safeParse(input);
  if (!p.success) throw new DomainError("validation", p.error.issues[0]?.message ?? "Invalid freight request.");
  const req: FreightRequest = { ...p.data, originPincode: p.data.originPincode ?? null };
  try {
    const got = await provider.estimate(req);
    if (got) return got;
  } catch {
    /* fall through to the card */
  }
  const est = estimateWithCard(req, await getActiveRateCard());
  return { ...est, assumptions: provider.id === "heuristic" ? est.assumptions : [...est.assumptions, "provider_fallback"] };
}
