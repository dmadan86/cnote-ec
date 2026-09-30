// Worker wiring (apps/worker mounts `worker`). Jobs are idempotent; serving-side jobs are skipped while ADS_ENABLED is off,
// but money-side jobs (settlement, re-scoring, rollups) always run so nothing owed is ever left unsettled.
import { expireLapsedAdPromo } from "@cnote/billing";
import type { ModuleWorker } from "@cnote/core";
import { attributeEnquiry, rescoreClicks } from "./clicks";
import { isAdsEnabled } from "./config";
import { invalidateSnapshot, runEligibilitySweep } from "./eligibility";
import { checkRevenueCap, checkWalletLow, rollupImpressions, settleSpend } from "./settlement";

const rebuild = async () => {
  if (isAdsEnabled()) await invalidateSnapshot();
};

export const worker: ModuleWorker = {
  name: "ads",
  handlers: {
    ListingModerated: rebuild,
    ListingImageModerated: rebuild,
    ListingArchived: rebuild,
    ListingUnpublished: rebuild,
    TrustScoreChanged: rebuild,
    BusinessVerified: rebuild,
    AdWalletToppedUp: rebuild,
    // ad-attributed enquiry: last valid click by the same buyer business within the window (idempotent per enquiry)
    EnquiryCreated: async (e) => {
      await attributeEnquiry({ enquiryId: e.payload.enquiryId, buyerBusinessId: e.payload.buyerBusinessId, categoryId: e.payload.categoryId });
    },
  },
  jobs: [
    { name: "ads.eligibility-sweep", everyMs: 60_000, run: async () => void (isAdsEnabled() && (await runEligibilitySweep())) },
    { name: "ads.rollup-impressions", everyMs: 15 * 60_000, run: async () => void (await rollupImpressions()) },
    { name: "ads.rescore-clicks", everyMs: 30 * 60_000, run: async () => void (await rescoreClicks()) },
    { name: "ads.settle-spend", everyMs: 60 * 60_000, run: async () => void (await settleSpend()) },
    { name: "ads.wallet-low", everyMs: 60 * 60_000, run: async () => void (await checkWalletLow()) },
    { name: "ads.expire-promo", everyMs: 6 * 60 * 60_000, run: async () => void (await expireLapsedAdPromo()) },
    { name: "ads.revenue-cap", everyMs: 24 * 60 * 60_000, run: async () => void (await checkRevenueCap()) },
  ],
};
