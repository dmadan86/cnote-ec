// @cnote/identity — Identity/Verification, sessions, trust score, consent ledger (ADR-003, ADR-010).
// Framework-free: apps/web reads the cookie and passes the token in.
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";

/** httpOnly cookies set by apps/web. Access = short-lived JWT; refresh = opaque, rotating. */
export const ACCESS_COOKIE = "cnote_at";
export const REFRESH_COOKIE = "cnote_rt";
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ConsentPurpose = "matching" | "marketing" | "voice_retention" | "counterparty_sharing";

export interface SessionBusiness {
  id: string;
  name: string;
  isSeller: boolean;
  isBuyer: boolean;
  verificationTier: number;
  trustScore: number;
  badgeActive: boolean;
}
export interface Session {
  sessionId: string; // AuthSession id (jwt "sid")
  personId: string;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  preferredLanguage: string;
  /** Active business (a person may belong to several; first owned one for now). */
  business: SessionBusiness | null;
  isOps: boolean; // email listed in OPS_EMAILS env
}

export interface TrustProfile {
  businessId: string;
  name: string;
  city: string | null;
  state: string | null;
  pincode: string | null;
  verificationTier: number;
  trustScore: number;
  badgeActive: boolean;
  languages: string[];
}

/** Request context for rate limiting + session metadata. */
export interface AuthContext {
  ip: string | null;
  userAgent: string | null;
}
export interface AuthTokens {
  personId: string;
  isNew: boolean;
  accessToken: string; // HS256 JWT: { sub: personId, sid: sessionId, exp }
  accessExpiresAt: string;
  refreshToken: string; // opaque; only its sha256 is stored
  refreshExpiresAt: string;
}

/** Email + password sign-up. Rate-limited per IP and per email. Password hashed with scrypt. */
export async function signUpWithPassword(input: { email: string; password: string; name?: string }, ctx: AuthContext): Promise<AuthTokens> {
  void input; void ctx;
  throw new Error("not implemented");
}
/** Rate-limited per IP and per email; constant-time compare; generic error message on failure. */
export async function signInWithPassword(input: { email: string; password: string }, ctx: AuthContext): Promise<AuthTokens> {
  void input; void ctx;
  throw new Error("not implemented");
}
/** Google OAuth (authorization code + PKCE). Caller stores state + codeVerifier in a short-lived httpOnly cookie. */
export async function googleAuthorizationUrl(redirectUri: string): Promise<{ url: string; state: string; codeVerifier: string }> {
  void redirectUri;
  throw new Error("not implemented");
}
/** Exchanges the code, verifies the ID token, links/creates Person by Google sub (or verified email). */
export async function completeGoogleSignIn(input: { code: string; codeVerifier: string; redirectUri: string }, ctx: AuthContext): Promise<AuthTokens> {
  void input; void ctx;
  throw new Error("not implemented");
}
/** Rotates the refresh token. Reuse of an old token revokes the whole session. */
export async function refreshSession(refreshToken: string, ctx: AuthContext): Promise<AuthTokens> {
  void refreshToken; void ctx;
  throw new Error("not implemented");
}
/** Verifies JWT signature/expiry and that the session is not revoked (Redis-cached). */
export async function getSession(accessToken: string | undefined | null): Promise<Session | null> {
  void accessToken;
  throw new Error("not implemented");
}
export async function signOut(refreshToken: string): Promise<void> {
  void refreshToken;
  throw new Error("not implemented");
}
export async function signOutAllSessions(personId: string): Promise<void> {
  void personId;
  throw new Error("not implemented");
}
export async function listAuthSessions(personId: string): Promise<{ id: string; userAgent: string | null; ip: string | null; createdAt: string; lastUsedAt: string; current?: boolean }[]> {
  void personId;
  throw new Error("not implemented");
}
/** Emails a reset link (dev: logged). Always resolves (no account enumeration). Rate-limited. */
export async function requestPasswordReset(email: string, ctx: AuthContext): Promise<void> {
  void email; void ctx;
  throw new Error("not implemented");
}
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  void token; void newPassword;
  throw new Error("not implemented");
}

/** T0 verification (ADR-003): phone OTP. Dev: code logged + returned when OTP_DEV_ECHO=true. Rate-limited. */
export async function requestPhoneOtp(personId: string, phone: string): Promise<{ sent: true; devCode?: string }> {
  void personId; void phone;
  throw new Error("not implemented");
}
export async function verifyPhoneOtp(personId: string, phone: string, code: string): Promise<{ verified: boolean }> {
  void personId; void phone; void code;
  throw new Error("not implemented");
}

export interface CreateBusinessInput {
  name: string;
  city?: string;
  state?: string;
  pincode?: string;
  isSeller: boolean;
  languages?: string[];
}
/** Creates a Business owned by the person; emits BusinessCreated (billing grants free-plan credits). */
export async function createBusiness(personId: string, input: CreateBusinessInput): Promise<{ businessId: string }> {
  void personId; void input;
  throw new Error("not implemented");
}
export async function updateProfile(personId: string, input: { name?: string; preferredLanguage?: string }): Promise<void> {
  void personId; void input;
  throw new Error("not implemented");
}

export async function getTrustProfiles(businessIds: string[]): Promise<Map<string, TrustProfile>> {
  void businessIds;
  throw new Error("not implemented");
}
/** Verified sellers, trust-ranked, for manufacturer discovery pages. */
export async function listSellers(opts: { q?: string; city?: string; limit?: number; offset?: number }): Promise<TrustProfile[]> {
  void opts;
  throw new Error("not implemented");
}

/** T1: GSTIN checksum + GSTN provider lookup (mock in dev), Udyam optional. Emits BusinessVerified. */
export async function verifyGstin(businessId: string, gstin: string, udyam?: string): Promise<{ passed: boolean; tier: number; reason?: string }> {
  void businessId; void gstin; void udyam;
  throw new Error("not implemented");
}
export async function listVerificationRecords(businessId: string): Promise<{ id: string; tier: number; kind: string; status: string; provider: string; createdAt: string }[]> {
  void businessId;
  throw new Error("not implemented");
}

export async function hasConsent(personId: string, purpose: ConsentPurpose): Promise<boolean> {
  void personId; void purpose;
  throw new Error("not implemented");
}
export async function setConsent(personId: string, purpose: ConsentPurpose, granted: boolean, source: string): Promise<void> {
  void personId; void purpose; void granted; void source;
  throw new Error("not implemented");
}
export async function getConsents(personId: string): Promise<Record<ConsentPurpose, boolean>> {
  void personId;
  throw new Error("not implemented");
}

/** DPDP data-principal rights: export everything held about a person. */
export async function exportPersonalData(personId: string): Promise<Record<string, unknown>> {
  void personId;
  throw new Error("not implemented");
}
/** DPDP erasure: tombstone PII, revoke sessions and consents, emit DataErasureRequested. */
export async function erasePerson(personId: string): Promise<void> {
  void personId;
  throw new Error("not implemented");
}

/** Consumes lead/dispute/moderation events to recompute trust scores; decay job. */
export const worker: ModuleWorker = { name: "identity", handlers: {}, jobs: [] };
