// @cnote/identity — Identity/Verification, sessions, trust score, consent ledger (ADR-003, ADR-010).
// Framework-free: apps/web reads the cookie and passes the token in.
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
export { REALMS, REALM_POLICY, cookieNames, isRealm, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from "./constants";
export type { Realm, RealmPolicy } from "./constants";
export type {
  ConsentPurpose, SessionBusiness, Session, TrustProfile, AuthContext, AuthTokens, CreateBusinessInput,
} from "./types";
export { ALL_COOKIE_CONSENT_PURPOSES, CONSENT_PURPOSES, COOKIE_CONSENT_PURPOSES, SELLER_COOKIE_CONSENT_PURPOSES } from "./types";

export { signUpWithPassword, signInWithPassword, requestPasswordReset, resetPassword, type SignUpInput } from "./auth";
export { googleAuthorizationUrl, completeGoogleSignIn, isGoogleConfigured } from "./google";
export { refreshSession, getSession, signOut, signOutAllSessions, listAuthSessions } from "./sessions";
export { requestPhoneOtp, verifyPhoneOtp } from "./otp";
export * from "./evidence";
export { createBusiness, ensureSystemBuyerBusiness, updateProfile, getTrustProfiles, listSellers, listSellerIndex, bustSellerCaches, listVerificationRecords, getBuyerBusinessProfile, type BuyerBusinessProfile } from "./business";
export { hasConsent, setConsent, getConsents, getConsentStates, type ConsentLedgerState } from "./consent";
export { exportPersonalData, erasePerson, erasePersonWithStepUp, verifyErasureStepUp, listPersonBusinessIds, STEP_UP_WINDOW_MS, type ErasureStepUp } from "./privacy";

export { computeTrustScore, BADGE_THRESHOLD, type TrustSignals } from "./trust";
export { isValidGstin, isValidUdyam, setGstnProvider, type GstnProvider, type GstnRecord } from "./gstin";
export { getSmsSender, setMailer, setSmsSender, type Mailer, type SmsSender } from "./mailer";
export { passwordProblem } from "./password";
export { enqueueAccountMail, type AccountMail } from "./mail-queue";

/** Consumes lead/dispute/moderation events to recompute trust scores; decay job. */
export { worker } from "./trust-worker";

// Sub-modules owned by parallel work streams (each adds its own exports in its file).
export * from "./gst";
export * from "./phone-login";
export * from "./directory";
export * from "./mfa";
export * from "./passkeys";
export * from "./retention";
export * from "./otp-senders";
export { findOrCreatePersonByVerifiedPhone } from "./verified-phone";
export * from "./kyc";
export * from "./audits";
export * from "./audit-partners";
export * from "./addresses";
export { getLastActiveAt, isInactivityEligible, listInactiveAccounts, findPersonIdByEmail, getOwnContacts, describePersonForStaff, type InactiveAccount } from "./inactivity";
export { touchLastActive } from "./sessions";
export * from "./registry";
