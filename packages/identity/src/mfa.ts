// TOTP multi-factor auth (ADR-010 security posture). Required for the admin realm, optional for sellers.
// The TOTP secret is envelope-encrypted with @cnote/security field encryption (context binds it to the
// person); recovery codes are stored only as sha256 hashes. Replay protection: a code's time-step can be
// accepted once (lastUsedStep, compare-and-swap).
import { randomBytes, randomInt } from "node:crypto";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { decryptField, encryptField, logSecurityEvent } from "@cnote/security";
import { enforceLimit } from "./limits";
import { sha256 } from "./tokens";
import { base32Decode, base32Encode, otpauthUri, verifyTotp } from "./totp";

export const RECOVERY_CODE_COUNT = 10;
const ctxOf = (personId: string) => `person_mfa.totp:${personId}`;
const issuer = () => process.env.MFA_ISSUER || "Cnote";
const bad = () => new DomainError("unauthenticated", "That code is incorrect or has already been used.");

export interface MfaStatus {
  /** TOTP confirmed and enforced at sign-in. */
  enabled: boolean;
  /** A secret was generated but not yet confirmed with a code. */
  enrolling: boolean;
  recoveryCodesLeft: number;
}

export async function mfaStatus(personId: string): Promise<MfaStatus> {
  const row = await prisma.personMfa.findUnique({ where: { personId } });
  return { enabled: !!row?.enabledAt, enrolling: !!row && !row.enabledAt && !!row.totpSecretEnc, recoveryCodesLeft: row?.recoveryCodeHashes.length ?? 0 };
}

export async function isMfaEnabled(personId: string): Promise<boolean> {
  return (await mfaStatus(personId)).enabled;
}

/** "ABCD EFGH IJKL …" for manual entry. */
const groupKey = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

/**
 * Step 1: generate a secret (or, while enrollment is still unconfirmed, re-show the same one so a page
 * refresh doesn't invalidate a scanned QR). Returns the otpauth:// URI (render as a QR code) and the manual
 * key. Refuses when MFA is already enabled: disable it first.
 */
export async function beginMfaEnrollment(personId: string, account: string): Promise<{ otpauthUri: string; manualKey: string }> {
  const existing = await prisma.personMfa.findUnique({ where: { personId } });
  if (existing?.enabledAt) throw new DomainError("conflict", "Two-factor authentication is already enabled.");
  let secretBase32: string;
  if (existing?.totpSecretEnc) {
    secretBase32 = await decryptField(existing.totpSecretEnc, ctxOf(personId));
  } else {
    secretBase32 = base32Encode(randomBytes(20));
    const totpSecretEnc = await encryptField(secretBase32, ctxOf(personId));
    await prisma.personMfa.upsert({ where: { personId }, create: { personId, totpSecretEnc }, update: { totpSecretEnc, enabledAt: null, recoveryCodeHashes: [], lastUsedStep: null } });
  }
  return { otpauthUri: otpauthUri({ secretBase32, account, issuer: issuer() }), manualKey: groupKey(secretBase32) };
}

// Crockford-style alphabet (no 0/O/1/I/L) for codes people type from paper.
const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function newRecoveryCode(): string {
  const raw = Array.from({ length: 10 }, () => RC_ALPHABET[randomInt(RC_ALPHABET.length)]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}
const normaliseRecovery = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");
const hashRecovery = (s: string) => sha256(normaliseRecovery(s));
const isTotpShape = (s: string) => /^\d{6}$/.test(s.replace(/\s/g, ""));

async function loadSecret(personId: string, requireEnabled: boolean) {
  const row = await prisma.personMfa.findUnique({ where: { personId } });
  if (!row?.totpSecretEnc || (requireEnabled ? !row.enabledAt : !!row.enabledAt)) return null;
  return { row, secret: base32Decode(await decryptField(row.totpSecretEnc, ctxOf(personId))) };
}

/** Accept a TOTP step once: true only for the caller that advances lastUsedStep. */
async function consumeStep(personId: string, step: number): Promise<boolean> {
  const r = await prisma.personMfa.updateMany({
    where: { personId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }] },
    data: { lastUsedStep: BigInt(step) },
  });
  return r.count === 1;
}

/** Fresh recovery codes (returned once, in plaintext) replacing any existing set. */
async function issueRecoveryCodes(personId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await prisma.personMfa.update({ where: { personId }, data: { recoveryCodeHashes: codes.map(hashRecovery) } });
  return codes;
}

/** Step 2: prove the authenticator works. Enables MFA and returns the 10 one-time recovery codes (shown once). */
export async function confirmMfaEnrollment(personId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  await enforceLimit(`mfa:verify:${personId}`, 8, 300, "Too many attempts. Please wait a few minutes.");
  const loaded = await loadSecret(personId, false);
  if (!loaded) throw new DomainError("validation", "Start enrollment first.", undefined, "account.startEnrollmentFirst");
  const step = verifyTotp(loaded.secret, code.replace(/\s/g, ""));
  if (step === null) {
    logSecurityEvent("mfa.failed", { personId, phase: "enroll" });
    throw bad();
  }
  await prisma.personMfa.update({ where: { personId }, data: { enabledAt: new Date(), lastUsedStep: BigInt(step) } });
  const recoveryCodes = await issueRecoveryCodes(personId);
  logSecurityEvent("mfa.enrolled", { personId });
  return { recoveryCodes };
}

export type MfaVerification = { method: "totp" | "recovery"; recoveryCodesLeft: number };

/**
 * Sign-in / step-up check. Accepts a 6-digit TOTP (±1 step, each step usable once) or a recovery code
 * (consumed atomically). Rate limited per person; failures are logged as security events.
 */
export async function verifyMfa(personId: string, input: string): Promise<MfaVerification> {
  await enforceLimit(`mfa:verify:${personId}`, 8, 300, "Too many attempts. Please wait a few minutes.");
  const loaded = await loadSecret(personId, true);
  if (!loaded) throw bad();
  const value = input.trim();

  if (isTotpShape(value)) {
    const step = verifyTotp(loaded.secret, value.replace(/\s/g, ""));
    if (step !== null && (await consumeStep(personId, step))) {
      logSecurityEvent("mfa.verified", { personId, method: "totp" });
      return { method: "totp", recoveryCodesLeft: loaded.row.recoveryCodeHashes.length };
    }
  } else if (normaliseRecovery(value).length === 10) {
    const hash = hashRecovery(value);
    // Atomic single-use: only the caller whose UPDATE removes the element wins.
    const removed = await prisma.$executeRaw`UPDATE person_mfa SET recovery_code_hashes = array_remove(recovery_code_hashes, ${hash}), updated_at = now() WHERE person_id = ${personId}::uuid AND ${hash} = ANY(recovery_code_hashes)`;
    if (removed === 1) {
      logSecurityEvent("mfa.recovery_used", { personId });
      return { method: "recovery", recoveryCodesLeft: Math.max(0, loaded.row.recoveryCodeHashes.length - 1) };
    }
  }
  logSecurityEvent("mfa.failed", { personId });
  throw bad();
}

/** Turn MFA off. Requires a valid current code (or recovery code), never just a session. */
export async function disableMfa(personId: string, code: string): Promise<void> {
  await verifyMfa(personId, code);
  await prisma.personMfa.delete({ where: { personId } });
  logSecurityEvent("mfa.disabled", { personId });
}

/** Replace the recovery codes (old ones stop working). Requires a valid current code. */
export async function regenerateRecoveryCodes(personId: string, code: string): Promise<string[]> {
  await verifyMfa(personId, code);
  return issueRecoveryCodes(personId);
}
