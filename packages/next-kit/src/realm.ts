// Each app is its own auth realm (web / seller / admin): separate JWT key + audience, cookies and
// refresh sessions. The realm is inlined at build time from the app's next.config.ts
// (`env: { CNOTE_AUTH_REALM: "admin" }`), so it cannot be flipped by runtime configuration.
// No next/headers import: safe in the proxy bundle.
import { getStaff } from "@cnote/admin";
import { cookieNames, isRealm, REALM_POLICY, type AuthContext, type Realm } from "@cnote/identity";

export function appRealm(): Realm {
  const r = process.env.CNOTE_AUTH_REALM;
  if (!isRealm(r)) throw new Error(`CNOTE_AUTH_REALM must be set in next.config.ts env to one of web|seller|admin (got ${String(r)})`);
  return r;
}

export function realmCookies() {
  return cookieNames(appRealm());
}

export function realmPolicy() {
  return REALM_POLICY[appRealm()];
}

/** Only active staff may hold an admin session; checked at sign-in and on every refresh. */
async function isActiveStaff(personId: string): Promise<boolean> {
  return (await getStaff(personId)) !== null;
}

/** Realm + admission guard to merge into every identity AuthContext built by this app. */
export function realmAuth(): Pick<AuthContext, "realm" | "allowPerson"> {
  const realm = appRealm();
  return realm === "admin" ? { realm, allowPerson: isActiveStaff } : { realm };
}
