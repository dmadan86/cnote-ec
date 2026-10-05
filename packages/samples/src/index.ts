// @cnote/samples: sample request and approval workflow before a bulk order. Flag SAMPLES_ENABLED. See docs/design/samples.md.
// PUBLIC CONTRACT. Extend, don't break. Sample payment is off-platform in Phase 1 (recorded only). Listing-level sample settings
// (available, price, max quantity, dispatch days, minimum buyer tier) are owned by @cnote/catalogue (TradeInfo); this module reads them
// through catalogue's public API. Trust: SampleEvaluated / SampleExpired events feed identity's trust worker; this module never writes there.
export type {
  Actor, AcceptSampleInput, BulkPrefill, DeclineReason, DeclineSampleInput, DispatchSampleInput, EvaluateSampleInput, GoldenSampleView, PhotoUpload,
  RejectReason, RequestSampleInput, SampleRole, SampleStatus, SampleSummary, SampleView, SellerSampleStats, ShipTo, TimelineEntry,
} from "./types";
export { samplesEnabled, sampleConfig, SAMPLE_RETENTION_DAYS, type SampleConfig } from "./config";
export {
  TRANSITIONS, OPEN_STATUSES, FINAL_STATUSES, DECLINE_REASONS, REJECT_REASONS, MAX_EVALUATION_PHOTOS, MAX_PHOTO_BYTES, canTransition, isOpen, approvalRate,
} from "./state";
export { setSamplePhotoStore, type SamplePhotoStore } from "./ports";
export { requestSample, cancelSample } from "./request";
export { acceptSample, declineSample, dispatchSample, markSampleDelivered, recordSamplePayment, evaluateSample } from "./lifecycle";
export { getBulkPrefill, linkBulkEnquiry, acceptLinkedQuote, getGoldenSampleForOrder } from "./bulk";
export {
  getSample, listBuyerSamples, listSellerSamples, countSellerPending, countBuyerActionable, getSellerSampleStats, readSamplePhoto, type SampleListOptions,
} from "./read";
export { expireOverdueSamples } from "./sla";
export { purgeClosedSamplePersonalData, erasePersonSamples } from "./retention";
export { worker } from "./worker";

// DPDP access right: registered with @cnote/compliance's export registry (security audit M10).
export { exportPersonalData } from "./privacy";
