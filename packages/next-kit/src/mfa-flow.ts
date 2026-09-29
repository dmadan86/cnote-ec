import "server-only";
// Sign-in MFA step (ADR-010 hardening). After credentials (password or Google) succeed we DO NOT hand the
// session tokens to the browser when a second factor is due. They are parked server-side (Redis, 5 min,
// envelope-encrypted) behind an opaque "mfa pending" httpOnly cookie; only a valid TOTP/recovery code (or,
// for an admin without MFA, completing enrollment) releases them.
//
//   admin realm:  MFA always required. Enrolled -> "verify"; not enrolled -> "enroll" (forced setup).
//   other realms: only when the person has enabled MFA (sellers may opt in).
import { randomBytes } from "node:crypto";
import { redis } from "@cnote/core";
import { beginMfaEnrollment, getSession, isMfaEnabled, signOut, type AuthTokens } from "@cnote/identity";
import { decryptField, encryptField } from "@cnote/security";
import { cookies } from "next/headers";
import { safeNext, setAuthCookies } from "./cookies";
import { appRealm } from "./realm";

export const MFA_PATH = "/mfa";
const PENDING_TTL_SECONDS = 5 * 60;

export type MfaMode = "verify" | "enroll";
interface Pending {
  personId: string;
  mode: MfaMode;
  next: string;
  /** Authenticator-app label (the person's email). */
  account: string;
  tokens: AuthTokens;
}

const key = (id: string) => `mfa:pending:${id}`;
const ctxOf = (id: string) => `mfa.pending:${id}`;
const secure = () => process.env.NODE_ENV === "production";

export const mfaPendingCookieName = () => `${secure() ? "__Host-" : ""}cnote_${appRealm()}_mfa`;

/** Development escape hatch only: never honoured in production. */
const adminMfaOptional = () => !secure() && process.env.MFA_ADMIN_OPTIONAL === "1";

export async function mfaRequirement(personId: string): Promise<MfaMode | null> {
  if (await isMfaEnabled(personId)) return "verify";
  return appRealm() === "admin" && !adminMfaOptional() ? "enroll" : null;
}

interface CookieSpec {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

/**
 * Call right after credentials were verified. Returns null when no second factor is due (caller sets the
 * session cookies as before). Otherwise parks the tokens and returns the pending cookie to set plus the page to send the user to.
 */
export async function beginMfaChallenge(tokens: AuthTokens, next: string | null | undefined): Promise<{ cookie: CookieSpec; path: string } | null> {
  const mode = await mfaRequirement(tokens.personId);
  if (!mode) return null;
  const id = randomBytes(32).toString("base64url");
  const account = (await getSession(tokens.accessToken, appRealm()))?.email ?? tokens.personId;
  const record: Pending = { personId: tokens.personId, mode, next: safeNext(next), account, tokens };
  await redis.set(key(id), await encryptField(JSON.stringify(record), ctxOf(id)), "EX", PENDING_TTL_SECONDS);
  return {
    cookie: { name: mfaPendingCookieName(), value: id, httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: PENDING_TTL_SECONDS },
    path: MFA_PATH,
  };
}

async function load(id: string | undefined, consume: boolean): Promise<Pending | null> {
  if (!id || id.length > 100) return null;
  const raw = consume ? await redis.getdel(key(id)) : await redis.get(key(id));
  if (!raw) return null;
  try {
    return JSON.parse(await decryptField(raw, ctxOf(id))) as Pending;
  } catch {
    return null;
  }
}

export interface MfaPendingView {
  personId: string;
  mode: MfaMode;
  next: string;
}

/** The pending sign-in for this browser (no secrets), or null when there is none / it expired. */
export async function getMfaPending(): Promise<MfaPendingView | null> {
  const id = (await cookies()).get(mfaPendingCookieName())?.value;
  const p = await load(id, false);
  return p ? { personId: p.personId, mode: p.mode, next: p.next } : null;
}

/** Release the parked session: sets the real auth cookies and clears the pending cookie. Single use. */
export async function completeMfaChallenge(): Promise<string | null> {
  const store = await cookies();
  const id = store.get(mfaPendingCookieName())?.value;
  const p = await load(id, true);
  store.delete(mfaPendingCookieName());
  if (!p) return null;
  setAuthCookies(store, p.tokens);
  return p.next;
}

/** Abandon the sign-in: forget the parked tokens and revoke the session they belong to. */
export async function discardMfaChallenge(): Promise<void> {
  const store = await cookies();
  const id = store.get(mfaPendingCookieName())?.value;
  const p = await load(id, true);
  if (p) await signOut(p.tokens.refreshToken, appRealm());
  store.delete(mfaPendingCookieName());
}

/** Authenticator setup details for a pending forced enrollment (admin's first sign-in). Idempotent until confirmed. */
export async function getMfaEnrollmentInfo(): Promise<{ manualKey: string; otpauthUri: string; done?: false } | { done: true } | null> {
  const id = (await cookies()).get(mfaPendingCookieName())?.value;
  const p = await load(id, false);
  if (!p || p.mode !== "enroll") return null;
  // Already confirmed (the page re-renders after the confirm action, or the user reloaded): only "continue" is left.
  if (await isMfaEnabled(p.personId)) return { done: true };
  const { otpauthUri, manualKey } = await beginMfaEnrollment(p.personId, p.account);
  return { otpauthUri, manualKey };
}
