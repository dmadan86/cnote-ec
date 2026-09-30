// @cnote/compliance: DPDP grievance redressal, moderation appeals, retention framework and the India data-residency
// guard (ADR-010). Queries ONLY GrievanceTicket, ModerationAppeal and RetentionRun; other modules are reached through
// their public exports (purge functions, moderation getters/decisions).
// PUBLIC CONTRACT. Extend, don't break.
export * from "./config";
export {
  GRIEVANCE_CATEGORIES, evaluateSla, fileGrievance, listGrievances, getGrievance, listMyGrievances, getMyGrievance, respondToGrievance, sweepGrievanceSla,
  type GrievanceCategory, type GrievanceStatus, type GrievanceSla, type GrievanceView, type GrievanceFilters, type FileGrievanceInput, type SlaSweepResult,
} from "./grievance";
export {
  APPEAL_SUBJECT_TYPES, describeSubject, fileAppeal, listMyAppeals, listAppeals, getAppealDetail, decideAppeal,
  type AppealSubjectType, type AppealStatus, type AppealActor, type AppealSubject, type AppealView,
} from "./appeals";
export {
  RETENTION_POLICIES, runRetention, runDueRetention, listRetentionRuns, describePolicies, windowDays, toCount,
  type RetentionPolicy, type RetentionResult, type RetentionRunView, type RunOptions,
} from "./retention";
export { assertIndiaResidency, getResidencyReport, ResidencyError, type ResidencyReport, type ResidencyCheck, type CheckStatus } from "./residency";
export { maskEmail } from "./util";
export { worker } from "./worker";
