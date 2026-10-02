// @cnote/compliance: DPDP grievance redressal, moderation appeals, retention framework and the India data-residency
// guard (ADR-010), plus cookie-consent receipts. Queries ONLY GrievanceTicket, ModerationAppeal, RetentionRun and CookieConsentReceipt; other modules are reached through
// their public exports (purge functions, moderation getters/decisions).
// PUBLIC CONTRACT. Extend, don't break.
export * from "./config";
export {
  GRIEVANCE_CATEGORIES, REQUEST_TYPES, isRightsRequest, evaluateSla, fileGrievance, listGrievances, getGrievance, listMyGrievances, getMyGrievance, respondToGrievance, sweepGrievanceSla,
  type GrievanceCategory, type RequestType, type GrievanceStatus, type GrievanceSla, type GrievanceView, type GrievanceFilters, type FileGrievanceInput, type SlaSweepResult,
} from "./grievance";
export {
  APPEAL_SUBJECT_TYPES, describeSubject, fileAppeal, listMyAppeals, listAppeals, getAppealDetail, decideAppeal,
  type AppealSubjectType, type AppealStatus, type AppealActor, type AppealSubject, type AppealView,
} from "./appeals";
export {
  RETENTION_POLICIES, runRetention, runDueRetention, listRetentionRuns, describePolicies, windowDays, toCount,
  type RetentionPolicy, type RetentionResult, type RetentionRunView, type RunOptions,
} from "./retention";
export {
  COOKIE_CONSENT_ACTIONS, CONSENT_LOCALES, cookieConsentSchema, recordCookieConsent, listCookieConsentReceipts, purgeCookieConsentReceipts,
  searchCookieConsentReceipts, iterateCookieConsentReceipts, cookieConsentStats, foldConsentStats, anonymizeCookieConsentReceipts,
  type CookieConsentAction, type CookieConsentInput, type CookieConsentReceiptView, type CookieConsentSearch, type CookieConsentStats,
} from "./consent";
export { assertIndiaResidency, getResidencyReport, ResidencyError, type ResidencyReport, type ResidencyCheck, type CheckStatus } from "./residency";
export { maskEmail } from "./util";
export { worker } from "./worker";
