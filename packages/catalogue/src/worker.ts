// The publisher's subscription side: reacts to review/trust/image events and runs the 30s publish sweep.
// Handlers are idempotent (delivery is at-least-once); LIVE is a rebuildable projection (see live.ts reconcileLive).
import type { EventHandlers, ScheduledJob } from "@cnote/core";
import { publishDueVersions, publishVersion, reconcileLive, reprojectImages, reprojectSeller } from "./live";

export const versionHandlers: EventHandlers = {
  // "Once approved, the publisher picks it up": immediate if due, otherwise the sweep publishes it at publishAt.
  ListingVersionReviewed: async (e) => {
    if (e.payload.status === "approved") await publishVersion(e.payload.versionId);
  },
  TrustScoreChanged: async (e) => void (await reprojectSeller(e.payload.businessId)),
  BusinessVerified: async (e) => void (await reprojectSeller(e.payload.businessId)),
  ListingImageProcessed: async (e) => void (await reprojectImages(e.payload.listingId)),
  ListingImageModerated: async (e) => void (await reprojectImages(e.payload.listingId)),
};

const HOUR_MS = 60 * 60 * 1000;
export const versionJobs: ScheduledJob[] = [
  { name: "catalogue.publish-due", everyMs: 30_000, run: async () => void (await publishDueVersions()) },
  { name: "catalogue.live-reconcile", everyMs: HOUR_MS, run: async () => void (await reconcileLive()) },
];
