// @cnote/quality: ADR-015 CV pre-dispatch quality checks (category-gated, advisory evidence for disputes). Flag QUALITY_CHECKS_ENABLED.
// PUBLIC CONTRACT. Outputs are advisory evidence: nothing here gates dispatch, payment or a dispute outcome.
import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { ANALYSE_TOPIC, QUALITY_MEDIA_RETENTION_DAYS } from "./config";
import { analyseCheck, requeueStuckChecks } from "./analyse";
import { purgeOldQualityMedia } from "./retention";

export * from "./types";
export {
  qualityChecksEnabled, envCategories, minAccuracy, minLabels, MAX_PHOTOS_PER_CHECK, MAX_CHECKS_PER_ORDER, VIDEO_MIN_FRAMES, VIDEO_MAX_FRAMES, VIDEO_MAX_SECONDS, VIDEO_MAX_BYTES, MAX_AI_IMAGES, QUALITY_MEDIA_RETENTION_DAYS, SUBMITTABLE_ORDER_STATUSES,
} from "./config";
export { getSubmissionContext, submitDispatchPhotos, qualityMediaKey } from "./submit";
export { listSellerChecks, listChecksForOrder, getCheckView, ADVISORY_DISCLAIMER } from "./views";
export { analyseCheck, requeueStuckChecks } from "./analyse";
export { buildChecklist, buildExpectedSpec } from "./spec";
export { setOrderContextPort, defaultOrderContextPort } from "./context";
export { categoryAccuracy, listCategoryStatuses, setCategoryEnabled, enabledCategories, isCategoryAllowed, type CategoryAccuracy, type CategoryStatus } from "./categories";
export { listForLabelling, labelResult, type LabellingItem } from "./labels";
export { readQualityMedia } from "./media";
export { purgeOldQualityMedia } from "./retention";

const DAY_MS = 86_400_000;
export const worker: ModuleWorker = {
  name: "quality",
  handlers: {},
  queues: [queueConsumer(ANALYSE_TOPIC, async (msg) => { await analyseCheck(msg.payload.checkId, { attempt: msg.attempt, maxAttempts: msg.maxAttempts }); }, 1)],
  jobs: [
    { name: "quality.requeue-stuck", everyMs: 5 * 60_000, run: async () => { const n = await requeueStuckChecks(); if (n) console.log(`[quality] requeued ${n} stuck checks`); } },
    {
      name: "quality.purge-media", everyMs: DAY_MS,
      run: async () => {
        const n = await purgeOldQualityMedia(new Date(Date.now() - QUALITY_MEDIA_RETENTION_DAYS * DAY_MS));
        if (n) console.log(`[quality] purged ${n} dispatch photos older than ${QUALITY_MEDIA_RETENTION_DAYS}d`);
      },
    },
  ],
};
