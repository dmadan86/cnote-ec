// WebAuthn passkeys (phishing-resistant second factor). Realm-parameterised: every function takes the auth realm and
// reads its relying-party config from `<REALM>_WEBAUTHN_*` env, so the seller/buyer realms can adopt passkeys later by
// setting env and wiring UI. Only the admin realm is wired today (docs/design/admin-passkeys.md; ADR-029, ADR-042).
//
//  * Challenges live in Redis (120 s, single use via GETDEL) keyed by realm + person.
//  * userVerification is "required": a passkey assertion proves possession AND a local PIN/biometric, so it satisfies
//    the second factor on its own after the password.
//  * A sign counter that fails to advance (when either side is non-zero) means the credential may be cloned: the
//    credential is revoked, an event is emitted and a security event is logged (alert). Signature is verified BEFORE
//    the counter check, so only the holder of the private key can trigger it.
import { DomainError, emit, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { logSecurityEvent } from "@cnote/security";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Realm } from "./constants";
import { enforceLimit } from "./limits";
import { verifyMfa } from "./mfa";
import { revokeAllSessions } from "./sessions";

export type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON };

export const MAX_PASSKEYS_PER_PERSON = 10;
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120;

type Env = Record<string, string | undefined>;
const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
const prefix = (realm: Realm) => realm.toUpperCase();
const isProd = (env: Env) => env.NODE_ENV === "production";

export interface PasskeyConfig {
  rpID: string;
  /** Exact browser origin, e.g. https://admin.example.com */
  origin: string;
  rpName: string;
}

/** Policy `<REALM>_REQUIRE_PASSKEY`: staff without a passkey must enroll one; TOTP-only sign-in is refused once they have one. */
export function passkeyRequired(realm: Realm, env: Env = process.env): boolean {
  return truthy(env[`${prefix(realm)}_REQUIRE_PASSKEY`]);
}

/** Passkeys are on for a realm when `<REALM>_PASSKEYS_ENABLED` or `<REALM>_REQUIRE_PASSKEY` is truthy. */
export function passkeysEnabled(realm: Realm, env: Env = process.env): boolean {
  return truthy(env[`${prefix(realm)}_PASSKEYS_ENABLED`]) || passkeyRequired(realm, env);
}

/** Relying-party config for a realm, or null when passkeys are off. Production needs explicit values (validateSecrets). */
export function passkeyConfig(realm: Realm, env: Env = process.env): PasskeyConfig | null {
  if (!passkeysEnabled(realm, env)) return null;
  const p = prefix(realm);
  let origin = env[`${p}_WEBAUTHN_ORIGIN`];
  let rpID = env[`${p}_WEBAUTHN_RP_ID`];
  if (!isProd(env)) {
    origin ??= env[`${p}_APP_URL`] ?? "http://localhost:3001";
    try {
      rpID ??= new URL(origin).hostname;
    } catch {
      /* invalid origin is reported below */
    }
  }
  if (!origin || !rpID) throw new Error(`${p}_WEBAUTHN_RP_ID and ${p}_WEBAUTHN_ORIGIN must be set to use passkeys.`);
  return { rpID, origin: origin.replace(/\/$/, ""), rpName: env.MFA_ISSUER || "Cnote" };
}

function requireConfig(realm: Realm): PasskeyConfig {
  const cfg = passkeyConfig(realm);
  if (!cfg) throw new DomainError("conflict", "Passkeys are not enabled.");
  return cfg;
}

const bad = () => new DomainError("unauthenticated", "Passkey verification failed. Please try again or use another method.");
const regKey = (realm: Realm, personId: string) => `webauthn:reg:${realm}:${personId}`;
const authKey = (realm: Realm, personId: string) => `webauthn:auth:${realm}:${personId}`;

export interface PasskeyView {
  id: string;
  nickname: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  aaguid: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const toView = (r: { id: string; nickname: string; deviceType: string; backedUp: boolean; transports: string[]; aaguid: string; createdAt: Date; lastUsedAt: Date | null }): PasskeyView => ({
  id: r.id, nickname: r.nickname, deviceType: r.deviceType, backedUp: r.backedUp, transports: r.transports, aaguid: r.aaguid,
  createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

export async function listPasskeys(realm: Realm, personId: string): Promise<PasskeyView[]> {
  const rows = await prisma.personPasskey.findMany({ where: { personId, realm, revokedAt: null }, orderBy: { createdAt: "asc" } });
  return rows.map(toView);
}

export async function countPasskeys(realm: Realm, personId: string): Promise<number> {
  return prisma.personPasskey.count({ where: { personId, realm, revokedAt: null } });
}

/** What sign-in needs to know in one call. */
export async function passkeyPolicy(realm: Realm, personId: string): Promise<{ enabled: boolean; required: boolean; hasPasskey: boolean }> {
  if (!passkeysEnabled(realm)) return { enabled: false, required: false, hasPasskey: false };
  return { enabled: true, required: passkeyRequired(realm), hasPasskey: (await countPasskeys(realm, personId)) > 0 };
}

const tx = (t?: string[]) => (t ?? []) as AuthenticatorTransport[];

// ---------- authentication (sign-in second factor, and step-up) ----------

/** Options for `navigator.credentials.get`. Challenge stored single-use. Person is already known (password step passed). */
export async function beginPasskeyAuthentication(realm: Realm, personId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const cfg = requireConfig(realm);
  await enforceLimit(`passkey:begin:${realm}:${personId}`, 20, 300, "Too many attempts. Please wait a few minutes.");
  const creds = await prisma.personPasskey.findMany({ where: { personId, realm, revokedAt: null } });
  if (!creds.length) throw new DomainError("conflict", "No passkey is registered for this account.");
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: "required",
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: tx(c.transports) })),
  });
  await redis.set(authKey(realm, personId), options.challenge, "EX", PASSKEY_CHALLENGE_TTL_SECONDS);
  return options;
}

/** Verify an assertion for `personId`. Updates counter/lastUsedAt; revokes the credential on a counter regression. */
export async function finishPasskeyAuthentication(realm: Realm, personId: string, response: AuthenticationResponseJSON): Promise<{ passkeyId: string }> {
  const cfg = requireConfig(realm);
  await enforceLimit(`passkey:verify:${realm}:${personId}`, 10, 300, "Too many attempts. Please wait a few minutes.");
  const challenge = await redis.getdel(authKey(realm, personId));
  const cred = challenge && typeof response?.id === "string" ? await prisma.personPasskey.findUnique({ where: { credentialId: response.id } }) : null;
  if (!challenge || !cred || cred.personId !== personId || cred.realm !== realm || cred.revokedAt) {
    logSecurityEvent("passkey.failed", { personId, realm, reason: !challenge ? "no_challenge" : "unknown_credential" });
    throw bad();
  }
  let newCounter: number;
  try {
    // counter: 0 on purpose. The library's own regression check throws before we could distinguish "bad signature" from
    // "valid signature, stale counter"; we do the counter check ourselves, after the signature is proven.
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpID,
      requireUserVerification: true,
      credential: { id: cred.credentialId, publicKey: new Uint8Array(cred.publicKey), counter: 0, transports: tx(cred.transports) },
    });
    if (!v.verified) throw new Error("not verified");
    newCounter = v.authenticationInfo.newCounter;
  } catch {
    logSecurityEvent("passkey.failed", { personId, realm, passkeyId: cred.id, reason: "invalid_assertion" });
    throw bad();
  }

  const stored = Number(cred.signCount);
  if ((stored > 0 || newCounter > 0) && newCounter <= stored) {
    await prisma.$transaction(async (t) => {
      const r = await t.personPasskey.updateMany({ where: { id: cred.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "clone_suspected" } });
      if (r.count !== 1) return;
      await emit(t, "PasskeyCloneSuspected", { type: "Person", id: personId }, { personId, realm, passkeyId: cred.id, storedCount: stored, receivedCount: newCounter });
      await emit(t, "PasskeyRevoked", { type: "Person", id: personId }, { personId, realm, passkeyId: cred.id, reason: "clone_suspected" });
    });
    logSecurityEvent("passkey.clone_suspected", { personId, realm, passkeyId: cred.id, storedCount: stored, receivedCount: newCounter });
    throw new DomainError("unauthenticated", "This passkey was revoked because it may have been copied. Contact a back-office owner to enroll a new one.", { cloneSuspected: true, passkeyId: cred.id });
  }
  const upd = await prisma.personPasskey.updateMany({
    where: { id: cred.id, revokedAt: null, signCount: cred.signCount },
    data: { signCount: BigInt(newCounter), lastUsedAt: new Date() },
  });
  if (upd.count !== 1) throw bad(); // lost a race with a concurrent use of the same credential
  logSecurityEvent("passkey.verified", { personId, realm, passkeyId: cred.id });
  return { passkeyId: cred.id };
}

// ---------- step-up ----------

/** Fresh proof of identity for sensitive passkey changes: an authenticator/recovery code, or (preferred) an assertion from an existing passkey. */
export type PasskeyStepUp = { code: string } | { assertion: AuthenticationResponseJSON };

export async function verifyPasskeyStepUp(realm: Realm, personId: string, proof: PasskeyStepUp | undefined): Promise<void> {
  if (!proof) throw new DomainError("unauthenticated", "Confirm it is you first.");
  if ("assertion" in proof) {
    await finishPasskeyAuthentication(realm, personId, proof.assertion);
    return;
  }
  // With the policy on, a person who has a passkey may not fall back to the phishable factor.
  if (passkeyRequired(realm) && (await countPasskeys(realm, personId)) > 0) throw new DomainError("forbidden", "Use your passkey to confirm.");
  await verifyMfa(personId, proof.code);
}

// ---------- registration ----------

/** Options for `navigator.credentials.create`. Caller must have passed step-up (or be in the forced-enrollment pending flow). */
export async function beginPasskeyRegistration(realm: Realm, personId: string, account: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const cfg = requireConfig(realm);
  await enforceLimit(`passkey:reg:${realm}:${personId}`, 10, 600, "Too many attempts. Please wait a few minutes.");
  const existing = await prisma.personPasskey.findMany({ where: { personId, realm, revokedAt: null } });
  if (existing.length >= MAX_PASSKEYS_PER_PERSON) throw new DomainError("conflict", `You can register at most ${MAX_PASSKEYS_PER_PERSON} passkeys.`);
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: account,
    userID: new TextEncoder().encode(personId),
    attestationType: "none", // we do not need attestation; avoids pulling in vendor trust chains
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: tx(c.transports) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await redis.set(regKey(realm, personId), options.challenge, "EX", PASSKEY_CHALLENGE_TTL_SECONDS);
  return options;
}

const cleanName = (s: string | undefined) => (s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);

export async function finishPasskeyRegistration(realm: Realm, personId: string, response: RegistrationResponseJSON, nickname?: string): Promise<PasskeyView> {
  const cfg = requireConfig(realm);
  await enforceLimit(`passkey:reg-finish:${realm}:${personId}`, 10, 600, "Too many attempts. Please wait a few minutes.");
  const challenge = await redis.getdel(regKey(realm, personId));
  if (!challenge) throw new DomainError("validation", "Passkey setup expired. Please start again.");
  let info;
  try {
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID, requireUserVerification: true });
    if (!v.verified) throw new Error("not verified");
    info = v.registrationInfo;
  } catch {
    logSecurityEvent("passkey.failed", { personId, realm, phase: "register" });
    throw new DomainError("validation", "That passkey could not be verified. Please try again.");
  }
  const count = await countPasskeys(realm, personId);
  if (count >= MAX_PASSKEYS_PER_PERSON) throw new DomainError("conflict", `You can register at most ${MAX_PASSKEYS_PER_PERSON} passkeys.`);
  const name = cleanName(nickname) || `Passkey ${count + 1}`;
  try {
    const row = await prisma.$transaction(async (t) => {
      const created = await t.personPasskey.create({
        data: {
          personId, realm, credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey), signCount: BigInt(info.credential.counter),
          transports: info.credential.transports ?? response.response.transports ?? [], aaguid: info.aaguid, deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp, nickname: name,
        },
      });
      await emit(t, "PasskeyRegistered", { type: "Person", id: personId }, { personId, realm, passkeyId: created.id, aaguid: created.aaguid, deviceType: created.deviceType });
      return created;
    });
    logSecurityEvent("passkey.registered", { personId, realm, passkeyId: row.id });
    return toView(row);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new DomainError("conflict", "That passkey is already registered.");
    throw err;
  }
}

// ---------- manage ----------

export async function renamePasskey(realm: Realm, personId: string, passkeyId: string, nickname: string): Promise<void> {
  const name = cleanName(nickname);
  if (!name) throw new DomainError("validation", "Enter a name for this passkey.");
  const r = await prisma.personPasskey.updateMany({ where: { id: passkeyId, personId, realm, revokedAt: null }, data: { nickname: name } });
  if (r.count !== 1) throw new DomainError("not_found", "Passkey not found.");
}

/** Revoke one passkey (step-up required). Under the require-passkey policy the last one cannot be removed. */
export async function revokePasskey(realm: Realm, personId: string, passkeyId: string, proof: PasskeyStepUp | undefined): Promise<void> {
  if (passkeyRequired(realm) && (await countPasskeys(realm, personId)) <= 1) {
    throw new DomainError("conflict", "Your organisation requires a passkey. Add another one before removing this one.");
  }
  await verifyPasskeyStepUp(realm, personId, proof);
  await prisma.$transaction(async (t) => {
    const r = await t.personPasskey.updateMany({ where: { id: passkeyId, personId, realm, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "user" } });
    if (r.count !== 1) throw new DomainError("not_found", "Passkey not found.");
    await emit(t, "PasskeyRevoked", { type: "Person", id: personId }, { personId, realm, passkeyId, reason: "user" });
  });
  logSecurityEvent("passkey.revoked", { personId, realm, passkeyId, reason: "user" });
}

/**
 * Recovery: revoke every passkey of a person and sign them out everywhere. Authorisation and the audit row are the
 * caller's job (apps/admin wraps this in `audited()` with an owner-level privilege). Returns how many were revoked.
 */
export async function resetPasskeys(realm: Realm, personId: string, byStaffId: string): Promise<number> {
  const active = await prisma.personPasskey.findMany({ where: { personId, realm, revokedAt: null }, select: { id: true } });
  await prisma.$transaction(async (t) => {
    await t.personPasskey.updateMany({ where: { personId, realm, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "reset" } });
    for (const { id } of active) await emit(t, "PasskeyRevoked", { type: "Person", id: personId }, { personId, realm, passkeyId: id, reason: "reset", byStaffId });
  });
  await revokeAllSessions(personId, realm);
  logSecurityEvent("passkey.revoked", { personId, realm, count: active.length, reason: "reset", byStaffId });
  return active.length;
}
