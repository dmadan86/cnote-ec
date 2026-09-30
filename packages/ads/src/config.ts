// Ads runtime configuration (ADR-024). Precedence: built-in default < environment < AdConfig rows (staff, ads.settings).
// Everything here is a founder-decision default and can be changed without a deploy through AdConfig.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";

/** The whole feature is behind ADS_ENABLED (default false). When false nothing is served; admin can still configure. */
export function isAdsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ADS_ENABLED?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export const DEFAULT_BOT_UA = [
  "bot", "crawl", "spider", "slurp", "headless", "phantom", "puppeteer", "playwright", "selenium", "curl/", "wget", "python-requests",
  "httpclient", "axios", "scrapy", "lighthouse", "facebookexternalhit", "preview", "go-http-client", "okhttp/0",
];

const shape = {
  /** minimum trust score for an advertiser (founder decision: 50; ADR floor: never below 50) */
  trustFloor: z.number().min(50).max(100).default(50),
  /** minimum verification tier for an advertiser (founder decision: 1) */
  minVerificationTier: z.number().int().min(1).max(5).default(1),
  /** minimum relevance (0..1) for an ad to be considered; below this no bid can buy a slot */
  minRelevance: z.number().min(0).max(1).default(0.3),
  /** no ads when the organic list has fewer results than this (cold categories) */
  minOrganicForAds: z.number().int().min(1).default(10),
  /** hard cap on the share of cards on a page that may be ads */
  maxAdShare: z.number().min(0).max(0.5).default(0.2),
  /** search/category: at most this many sponsored slots, and 1 per `perOrganicResults` organic results */
  maxSearchSlots: z.number().int().min(0).max(4).default(2),
  perOrganicResults: z.number().int().min(1).default(10),
  /** product page "Sponsored similar" rail */
  maxProductSlots: z.number().int().min(0).max(4).default(2),
  frequencyCap: z.number().int().min(1).default(5),
  frequencyWindowHours: z.number().int().min(1).default(24),
  attributionWindowDays: z.number().int().min(1).max(30).default(7),
  invalidClickRescoreHours: z.number().int().min(1).max(168).default(72),
  /** clicks younger than this are not yet resolved from pending by the re-score job */
  rescoreMinAgeHours: z.number().min(0).default(1),
  clickDedupeMinutes: z.number().int().min(1).default(30),
  clickBurstPerNetHour: z.number().int().min(1).default(8),
  campaignClicksPerMinute: z.number().int().min(1).default(60),
  netDailyCap: z.number().int().min(1).default(15),
  visitorDailyCap: z.number().int().min(1).default(3),
  tokenTtlMinutes: z.number().int().min(1).default(30),
  /** ads as a share (%) of trailing-90-day revenue; monitoring alert only */
  revenueCapPct: z.number().min(0).max(100).default(20),
  walletLowDays: z.number().min(0).default(3),
  walletLowFloorPaise: z.number().int().min(0).default(20_000),
  minDailyBudgetPaise: z.number().int().min(0).default(10_000),
  /** pacing: eligible while spend <= dailyBudget * elapsedFraction * paceMultiplier */
  paceMultiplier: z.number().min(1).default(1.2),
  /** scores within this ratio of each other are near-ties and rotate */
  nearTieRatio: z.number().min(0).max(0.5).default(0.05),
  botUserAgentPatterns: z.array(z.string().min(1).max(60)).max(100).default(DEFAULT_BOT_UA),
  /** eligibility snapshot lifetime (seconds) */
  snapshotTtlSeconds: z.number().int().min(10).default(180),
};

export const adsConfigSchema = z.object(shape);
export type AdsConfig = z.infer<typeof adsConfigSchema>;
export const ADS_CONFIG_KEYS = Object.keys(shape) as (keyof AdsConfig)[];

const ENV_NAMES: Partial<Record<keyof AdsConfig, string>> = {
  trustFloor: "ADS_TRUST_FLOOR",
  minVerificationTier: "ADS_MIN_TIER",
  minRelevance: "ADS_MIN_RELEVANCE",
  minOrganicForAds: "ADS_MIN_ORGANIC",
  maxAdShare: "ADS_MAX_AD_SHARE",
  maxSearchSlots: "ADS_MAX_SEARCH_SLOTS",
  maxProductSlots: "ADS_MAX_PRODUCT_SLOTS",
  frequencyCap: "ADS_FREQUENCY_CAP",
  attributionWindowDays: "ADS_ATTRIBUTION_DAYS",
  invalidClickRescoreHours: "ADS_RESCORE_HOURS",
  revenueCapPct: "ADS_REVENUE_CAP_PCT",
  minDailyBudgetPaise: "ADS_MIN_DAILY_BUDGET_PAISE",
  walletLowDays: "ADS_WALLET_LOW_DAYS",
};

/** Pure merge: defaults < env < DB rows. Invalid values are ignored (the previous layer wins), never thrown. */
export function resolveAdsConfig(rows: { key: string; value: unknown }[], env: NodeJS.ProcessEnv = process.env): AdsConfig {
  const layer: Record<string, unknown> = {};
  const apply = (key: string, value: unknown) => {
    const field = (shape as Record<string, z.ZodType>)[key];
    if (!field) return;
    const ok = field.safeParse(value);
    if (ok.success) layer[key] = ok.data;
  };
  for (const [key, name] of Object.entries(ENV_NAMES)) {
    const raw = env[name!];
    if (raw !== undefined && raw !== "") apply(key, Number(raw));
  }
  for (const r of rows) apply(r.key, r.value);
  return adsConfigSchema.parse(layer);
}

let cache: { at: number; value: AdsConfig } | null = null;
const CACHE_MS = 30_000;

export async function getAdsConfig(now = Date.now()): Promise<AdsConfig> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const rows = await prisma.adConfig.findMany();
  const value = resolveAdsConfig(rows);
  cache = { at: now, value };
  return value;
}

export function resetAdsConfigCache(): void {
  cache = null;
}

/** Staff (ads.settings; the caller wraps this in audited()). Validates each key and clamps nothing silently. */
export async function setAdsConfig(patch: Partial<AdsConfig>, staffId: string | null): Promise<AdsConfig> {
  for (const [key, value] of Object.entries(patch)) {
    const field = (shape as Record<string, z.ZodType>)[key];
    if (!field) throw new DomainError("validation", `Unknown ads config key: ${key}`);
    const parsed = field.safeParse(value);
    if (!parsed.success) throw new DomainError("validation", `Invalid value for ${key}: ${parsed.error.issues[0]?.message}`);
    await prisma.adConfig.upsert({
      where: { key },
      create: { key, value: parsed.data as never, updatedBy: staffId },
      update: { value: parsed.data as never, updatedBy: staffId },
    });
  }
  resetAdsConfigCache();
  return getAdsConfig();
}

/**
 * Source of truth for the public "How ranking and ads work" page (Consumer Protection (E-Commerce) Rules r.5(3)(f)/(15)).
 * The page renders from these constants, so it cannot drift from the code. Bump `version` when any value changes.
 */
export const RANKING_DISCLOSURE = {
  version: 1,
  updated: "2026-09-30",
  organic: {
    formula: "relevance x trust",
    trustWeightMaxPct: 40,
    locationBoostPct: 10,
    paymentAffectsOrganic: false,
    planAffectsOrganic: false,
  },
  sponsored: {
    labelled: true,
    rankedBy: "relevance x trust",
    pricing: "fixed price per click from a public rate card",
    maxSlotsSearch: 2,
    oneAdPerOrganicResults: 10,
    maxShareOfCardsPct: 20,
    minOrganicResults: 10,
    onePerSellerPerPage: true,
    minTrustScore: 50,
    minVerificationTier: 1,
    higherSpendBuysHigherRank: false,
  },
  never: ["verification badges", "lead priority", "organic search rank"],
} as const;
