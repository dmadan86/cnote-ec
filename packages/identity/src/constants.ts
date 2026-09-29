/**
 * Session realms: each app is an isolated auth domain (separate signing key, JWT audience, cookies,
 * refresh sessions and lifetimes). A token minted for one realm is rejected by every other.
 */
export const REALMS = ["web", "seller", "admin"] as const;
export type Realm = (typeof REALMS)[number];

export interface RealmPolicy {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** env var holding a dedicated signing secret; falls back to a key derived from JWT_SECRET */
  secretEnv: string;
  /** public base URL of the app (password-reset links etc.) */
  appUrlEnv: string;
  appUrlDefault: string;
}

export const REALM_POLICY: Record<Realm, RealmPolicy> = {
  web: { accessTtlSeconds: 15 * 60, refreshTtlSeconds: 30 * 24 * 3600, secretEnv: "JWT_SECRET_WEB", appUrlEnv: "APP_URL", appUrlDefault: "http://localhost:3000" },
  seller: { accessTtlSeconds: 15 * 60, refreshTtlSeconds: 30 * 24 * 3600, secretEnv: "JWT_SECRET_SELLER", appUrlEnv: "SELLER_APP_URL", appUrlDefault: "http://localhost:3002" },
  // Back office: short-lived everything; refresh never extends past 12h from sign-in (absolute cap).
  admin: { accessTtlSeconds: 5 * 60, refreshTtlSeconds: 12 * 3600, secretEnv: "JWT_SECRET_ADMIN", appUrlEnv: "ADMIN_APP_URL", appUrlDefault: "http://localhost:3001" },
};

export function isRealm(v: unknown): v is Realm {
  return typeof v === "string" && (REALMS as readonly string[]).includes(v);
}

/** Cookie names per realm. `__Host-` in production pins cookies to the exact host (no Domain, Secure, Path=/). */
export function cookieNames(realm: Realm, secure = process.env.NODE_ENV === "production") {
  const p = secure ? "__Host-" : "";
  return { access: `${p}cnote_${realm}_at`, refresh: `${p}cnote_${realm}_rt` };
}

/** @deprecated realm-less defaults (web realm); use REALM_POLICY / cookieNames(realm). */
export const ACCESS_TTL_SECONDS = REALM_POLICY.web.accessTtlSeconds;
/** @deprecated see ACCESS_TTL_SECONDS */
export const REFRESH_TTL_SECONDS = REALM_POLICY.web.refreshTtlSeconds;
export const JWT_ISSUER = "cnote";
