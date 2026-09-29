// @cnote/identity — Identity/Verification, sessions, trust score, consent ledger (ADR-003, ADR-010).
// Framework-free: apps/web reads the cookie and passes the token in.
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
export { ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from "./constants";
export type {
  ConsentPurpose, SessionBusiness, Session, TrustProfile, AuthContext, AuthTokens, CreateBusinessInput,
} from "./types";
export { CONSENT_PURPOSES } from "./types";

export { signUpWithPassword, signInWithPassword, requestPasswordReset, resetPassword, type SignUpInput } from "./auth";
export { googleAuthorizationUrl, completeGoogleSignIn, isGoogleConfigured } from "./google";
export { refreshSession, getSession, signOut, signOutAllSessions, listAuthSessions } from "./sessions";
export { requestPhoneOtp, verifyPhoneOtp } from "./otp";
export { createBusiness, updateProfile, getTrustProfiles, listSellers, verifyGstin, listVerificationRecords } from "./business";
export { hasConsent, setConsent, getConsents } from "./consent";
export { exportPersonalData, erasePerson } from "./privacy";

export { computeTrustScore, BADGE_THRESHOLD, type TrustSignals } from "./trust";
export { isValidGstin, isValidUdyam, setGstnProvider, type GstnProvider, type GstnRecord } from "./gstin";
export { setMailer, setSmsSender, type Mailer, type SmsSender } from "./mailer";
export { passwordProblem } from "./password";

/** Consumes lead/dispute/moderation events to recompute trust scores; decay job. */
export { worker } from "./trust-worker";
