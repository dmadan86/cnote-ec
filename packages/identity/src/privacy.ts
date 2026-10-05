import { DomainError, emit } from "@cnote/core";
import { Prisma, prisma } from "@cnote/db";
import { enforceLimit } from "./limits";
import { isMfaEnabled, verifyMfa } from "./mfa";
import { verifyPassword } from "./password";
import { revokeAllSessions } from "./sessions";
import { eraseTeamData, exportTeamData } from "./team-privacy";
import { CONSENT_PURPOSES } from "./types";

/** DPDP access right: everything this module holds about a person (no credential hashes). */
export async function exportPersonalData(personId: string): Promise<Record<string, unknown>> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      memberships: { include: { business: true } },
      consents: { orderBy: { createdAt: "asc" } },
      authSessions: { orderBy: { createdAt: "desc" } },
      authIdentities: true,
    },
  });
  if (!person) return {};
  const { memberships, consents, authSessions, authIdentities, passwordHash, ...p } = person;
  void passwordHash;
  const businessIds = memberships.map((m) => m.businessId);
  const addresses = businessIds.length ? await prisma.businessAddress.findMany({ where: { businessId: { in: businessIds } }, orderBy: { createdAt: "asc" } }) : [];
  return {
    exportedAt: new Date().toISOString(),
    person: p,
    businesses: memberships.map((m) => ({ role: m.role, ...m.business })),
    // businesses[].gstin / legalName / pan / udyam are included above (the full Business row); addresses are listed here.
    deliveryAddresses: addresses.map(({ id, businessId, label, contactName, phone, line1, line2, city, state, pincode, isDefault, createdAt }) => ({ id, businessId, label, contactName, phone, line1, line2, city, state, pincode, isDefault, createdAt })),
    consents: consents.map((c) => ({ purpose: c.purpose, granted: c.granted, source: c.source, createdAt: c.createdAt })),
    sessions: authSessions.map((s) => ({ id: s.id, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt })),
    loginIdentities: authIdentities.map((i) => ({ provider: i.provider, email: i.email, createdAt: i.createdAt })),
    team: await exportTeamData(personId),
  };
}

/** DPDP erasure: tombstone PII (row kept for referential integrity), revoke sessions, withdraw consents. */
export async function erasePerson(personId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Businesses this person alone belongs to: their saved addresses and (non-seller) GST identifiers go with them.
    // Seller businesses keep GSTIN/PAN: tax-invoice and trust-record retention outranks erasure (DPDP s.8(7) / ADR-010).
    await eraseTeamData(tx, personId); // invitations hold email addresses: delete them before the email is tombstoned
    const memberships = await tx.businessMember.findMany({ where: { personId }, select: { businessId: true } });
    const sole: string[] = [];
    for (const m of memberships) if ((await tx.businessMember.count({ where: { businessId: m.businessId } })) === 1) sole.push(m.businessId);
    if (sole.length) {
      await tx.businessAddress.deleteMany({ where: { businessId: { in: sole } } });
      await tx.business.updateMany({
        where: { id: { in: sole }, isSeller: false },
        data: { gstin: null, udyam: null, pan: null, legalName: null, tradeName: null, cin: null, registeredAddress: Prisma.JsonNull, gstStatus: null, gstVerifiedAt: null, gstLastCheckedAt: null, verificationTier: 0, badgeActive: false },
      });
    }
    await tx.person.update({
      where: { id: personId },
      data: { email: null, emailVerifiedAt: null, phone: null, phoneVerifiedAt: null, name: null, avatarUrl: null, passwordHash: null, erasedAt: new Date() },
    });
    await tx.authIdentity.deleteMany({ where: { personId } });
    await tx.personMfa.deleteMany({ where: { personId } });
    await tx.consent.createMany({ data: CONSENT_PURPOSES.map((purpose) => ({ personId, purpose, granted: false, source: "erasure" })) });
    await emit(tx, "DataErasureRequested", { type: "Person", id: personId }, { personId });
  });
  await revokeAllSessions(personId);
}

/** Business ids the person belongs to: context for the cross-module export registry (@cnote/compliance). */
export async function listPersonBusinessIds(personId: string): Promise<string[]> {
  return (await prisma.businessMember.findMany({ where: { personId }, select: { businessId: true } })).map((m) => m.businessId);
}

// ---- Step-up for irreversible account erasure (security audit M10) ----------------------------------------------------

/** A step-up proof is only good for this long: a password / MFA code is checked at the moment of the request, a phone OTP may be at most this old. */
export const STEP_UP_WINDOW_MS = 5 * 60_000;

/** Proof that the person at the keyboard is the account owner right now. Provide the strongest factor the account has. */
export interface ErasureStepUp {
  password?: string;
  /** TOTP or recovery code. Required when the account has MFA enabled (a password alone is then not enough). */
  mfaCode?: string;
}

const STEP_UP_REQUIRED = () => new DomainError("forbidden", "Confirm it's you to continue: re-enter your password, or a fresh verification code.");

/**
 * Throws unless the caller proves identity within the last 5 minutes: the account password, an MFA code, or a phone OTP verified
 * in the last 5 minutes (`phoneVerifiedAt`, set by `verifyPhoneOtp`). Accounts with MFA enabled need the MFA code.
 * Rate-limited per person so the erase form cannot be used to brute-force the password.
 */
export async function verifyErasureStepUp(personId: string, proof: ErasureStepUp = {}, now = new Date()): Promise<"mfa" | "password" | "otp"> {
  await enforceLimit(`erase:stepup:${personId}`, 5, 600, "Too many attempts. Please wait a few minutes and try again.");
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { passwordHash: true, phoneVerifiedAt: true, erasedAt: true } });
  if (!person || person.erasedAt) throw new DomainError("not_found", "Account not found");
  const mfaCode = proof.mfaCode?.trim();
  if (mfaCode) {
    await verifyMfa(personId, mfaCode); // throws on a wrong code
    return "mfa";
  }
  if (await isMfaEnabled(personId)) throw new DomainError("forbidden", "Enter your authenticator or recovery code to continue.");
  const password = proof.password ? String(proof.password).slice(0, 256) : "";
  if (password && person.passwordHash) {
    if (await verifyPassword(password, person.passwordHash)) return "password";
    throw new DomainError("forbidden", "That password is not correct.");
  }
  if (person.phoneVerifiedAt && now.getTime() - person.phoneVerifiedAt.getTime() <= STEP_UP_WINDOW_MS) return "otp";
  throw STEP_UP_REQUIRED();
}

/** Account erasure behind step-up. The web action calls this; `erasePerson` stays for staff-driven and system erasure. */
export async function erasePersonWithStepUp(personId: string, proof: ErasureStepUp): Promise<void> {
  await verifyErasureStepUp(personId, proof);
  await erasePerson(personId);
}
