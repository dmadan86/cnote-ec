// @cnote/ads — Sponsored Products (ADR-024). Organic ranking (ADR-009) never reads this package; ads are merged AFTER it.
// Whole feature behind ADS_ENABLED (default false). PUBLIC CONTRACT: extend, don't break.
export { isAdsEnabled, getAdsConfig, setAdsConfig, resolveAdsConfig, ADS_CONFIG_KEYS, RANKING_DISCLOSURE, resetAdsConfigCache, type AdsConfig } from "./config";

// serving
export { getSponsoredSlots, scoreCandidate, DECISION_TIMEOUT_MS, type SponsoredSlot, type SponsoredSlotsInput } from "./decision";
export { slotAllowance, placeSlots, mergeSponsored, relevanceOf, rankScored, paceDecision, trustFactor, normaliseKeyword, type PlacementSurface } from "./relevance";
export { runEligibilitySweep, invalidateSnapshot, waitForBackgroundSweeps, loadSnapshot, judgeEligibility, type AdCandidate, type AdSnapshot, type SweepResult } from "./eligibility";
export { setKillSwitch, getKillSwitches, reserveSpend, releaseSpend, getSpentToday } from "./budget";

// clicks, attribution
export { recordClick, rescoreClicks, invalidateClick, invalidateClicksByStaff, attributeEnquiry, classifyUserAgent, realtimeVerdict, type ClickContext, type ClickOutcome } from "./clicks";
export { signClickToken, verifyClickToken } from "./tokens";

// seller
export {
  createCampaign, updateCampaign, addAdGroup, updateAdGroup, addListingToGroup, removeListingFromGroup, addKeyword, removeKeyword, submitCampaign,
  pauseCampaign, resumeCampaign, endCampaign, listCampaigns, getCampaign, type CampaignSummary, type CampaignDetail, type CampaignInput, type AdGroupInput,
} from "./campaigns";
export { getCampaignReport, getAdvertiserOverview, type CampaignReport } from "./reports";
export { getPublicRateCard, setRateCard, resolveRate, type RateCardEntry } from "./rate-card";

// staff
export {
  listReviewQueue, getCampaignForReview, reviewItem, decideCampaign, suspendCampaign, suspendBusinessAds, unsuspendCampaign,
  listCampaignsForAdmin, listInvalidTraffic, listClicksForReview, REASON_CODES, type ReasonCode,
} from "./review";

// money-side jobs and monitors
export { settleSpend, rollupImpressions, checkWalletLow, getRevenueCapStatus, checkRevenueCap, type RevenueCapStatus } from "./settlement";

export { worker } from "./worker";
