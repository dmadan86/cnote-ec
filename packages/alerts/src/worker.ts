import type { ModuleWorker } from "@cnote/core";
import { runFollowedDigests, runSavedSearchDigests } from "./digests";
import { onListingPriceChanged, onListingPublished } from "./listing-alerts";
import { eraseAlertsData } from "./privacy";

const HOUR_MS = 3_600_000;

export const worker: ModuleWorker = {
  name: "alerts",
  handlers: {
    ListingPriceChanged: async (e) => void (await onListingPriceChanged(e)),
    ListingPublished: async (e) => void (await onListingPublished(e)),
    DataErasureRequested: async (e) => eraseAlertsData(e.payload.personId),
  },
  jobs: [
    { name: "alerts.saved-search-digests", everyMs: HOUR_MS, run: async () => void (await runSavedSearchDigests()) },
    { name: "alerts.followed-digests", everyMs: HOUR_MS, run: async () => void (await runFollowedDigests()) },
  ],
};
