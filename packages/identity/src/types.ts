import type { Realm } from "./constants";
export type ConsentPurpose = "matching" | "marketing" | "voice_retention" | "counterparty_sharing" | "credit_underwriting";
export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ["matching", "marketing", "voice_retention", "counterparty_sharing", "credit_underwriting"];

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
