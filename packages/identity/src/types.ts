import type { Realm } from "./constants";
export type ConsentPurpose = "matching" | "marketing" | "voice_retention" | "counterparty_sharing" | "credit_underwriting" | "analytics_cookies" | "marketing_cookies" | "functional_cookies" | "seller_analytics_cookies" | "seller_marketing_cookies";
export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ["matching", "marketing", "voice_retention", "counterparty_sharing", "credit_underwriting", "analytics_cookies", "marketing_cookies", "functional_cookies", "seller_analytics_cookies", "seller_marketing_cookies"];
/** Cookie-banner choices mirrored into the ledger for signed-in people (written by the buyer web's POST /api/consent, not by account forms). */
export const COOKIE_CONSENT_PURPOSES = ["analytics_cookies", "marketing_cookies", "functional_cookies"] as const satisfies readonly ConsentPurpose[];
/** The seller app's cookie-banner choices mirrored into the ledger (written by the seller's POST /api/consent). Separate purposes: onboarding timing and referral attribution are not the buyer web's analytics/marketing. */
export const SELLER_COOKIE_CONSENT_PURPOSES = ["seller_analytics_cookies", "seller_marketing_cookies"] as const satisfies readonly ConsentPurpose[];
/** Every cookie-banner purpose: none of them belongs on an account/settings form. */
export const ALL_COOKIE_CONSENT_PURPOSES: readonly ConsentPurpose[] = [...COOKIE_CONSENT_PURPOSES, ...SELLER_COOKIE_CONSENT_PURPOSES];

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
  /** ISO timestamp the business was created (auto-approval account-age gate) */
  createdAt?: string;
}

/** Request context for rate limiting + session metadata. */
export interface AuthContext {
  ip: string | null;
  userAgent: string | null;
  /** Session realm (the app). Defaults to "web". Tokens and refresh sessions never cross realms. */
  realm?: Realm;
  /**
   * Admission guard evaluated after credentials are verified and before a session is issued, e.g.
   * the admin app requires an active StaffMember. Rejection looks identical to bad credentials.
   */
  allowPerson?: (personId: string) => Promise<boolean>;
}
export interface AuthTokens {
  personId: string;
  isNew: boolean;
  accessToken: string; // HS256 JWT: { sub: personId, sid: sessionId, exp }
  accessExpiresAt: string;
  refreshToken: string; // opaque; only its sha256 is stored
  refreshExpiresAt: string;
}

export interface CreateBusinessInput {
  name: string;
  city?: string;
  state?: string;
  pincode?: string;
  isSeller: boolean;
  languages?: string[];
}
