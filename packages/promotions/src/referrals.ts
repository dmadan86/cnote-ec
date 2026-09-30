// Referral credits (ADR-025 (4), design 6.4). Rewards are LEAD CREDITS (billing.grantCredits, 90-day expiry), never cash.
// No address-book import and no platform-sent messages to non-users: the referrer shares their own link.
//
// Lifecycle: pending (referee joined) -> qualified (tier >= 1 AND a first published listing / first verified enquiry; 7-day hold)
// -> rewarded (both sides, idempotent grants) | rejected (reason shown to the referrer, no silent denial).
// Flagged referrals (shared phone, GSTIN or person, referral rings) are never auto-released: they wait for `referrals.review`.
import { createHash } from "node:crypto";
import { grantCredits } from "@cnote/billing";
import { listPublicSellerListings } from "@cnote/catalogue";
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { addDays, REFERRAL } from "./config";
import { riskKeys } from "./ports";

export type ReferralAction = "listing_published" | "first_verified_enquiry";
export type ReferralStatusName = "pending" | "qualified" | "rewarded" | "rejected" | "expired";

// ------------------------------------------------------------------------------------------------ codes
// The code is self-describing (the referrer's business id, base32) plus a 2-char checksum, so no lookup table is needed and a
// mistyped code fails fast. It identifies a business only to us; it is not a secret and grants nothing by itself.
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function b32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unb32(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
const check = (body: string) => b32(createHash("sha256").update(`ref:${body}`).digest().subarray(0, 2)).slice(0, 2);

/** Stable personal referral code for a business. */
export function referralCodeFor(businessId: string): string {
  const body = b32(Buffer.from(businessId.replace(/-/g, ""), "hex"));
  return `R${body}${check(body)}`;
}

/** Decodes a code to the referrer's business id; null when malformed or the checksum fails. */
export function decodeReferralCode(code: string): string | null {
  const c = code.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^R[A-Z2-9]{26,28}$/.test(c)) return null;
  const body = c.slice(1, -2);
  if (check(body) !== c.slice(-2)) return null;
  const bytes = unb32(body);
  if (!bytes || bytes.length < 16) return null;
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ReferralView {
  id: string;
  referrerBusinessId: string;
  refereeBusinessId: string;
  refereeName?: string;
  code: string;
  status: ReferralStatusName;
  qualifyingAction: string | null;
  qualifiedAt: string | null;
  holdUntil: string | null;
  rewardedAt: string | null;
  rewardCredits: number | null;
  rejectedReason: string | null;
  riskFlags: string[];
  createdAt: string;
}
type Row = NonNullable<Awaited<ReturnType<typeof prisma.referral.findUnique>>>;
const toView = (r: Row): ReferralView => ({
  id: r.id, referrerBusinessId: r.referrerBusinessId, refereeBusinessId: r.refereeBusinessId, code: r.code, status: r.status, qualifyingAction: r.qualifyingAction,
  qualifiedAt: r.qualifiedAt?.toISOString() ?? null, holdUntil: r.holdUntil?.toISOString() ?? null, rewardedAt: r.rewardedAt?.toISOString() ?? null, rewardCredits: r.rewardCredits,
  rejectedReason: r.rejectedReason, riskFlags: r.riskFlags, createdAt: r.createdAt.toISOString(),
});

// ------------------------------------------------------------------------------------------------ attach

/**
 * Called at signup/onboarding when the referee arrives with a code. One referrer per referee (unique). Blatant self-referral
 * (same business or a shared person) is refused outright; softer overlaps (shared phone/GSTIN, or the referrer was themselves
 * referred by the referee) are stored as risk flags and route the reward to staff review.
 */
export async function applyReferralCode(input: { refereeBusinessId: string; code: string; extraFlags?: string[] }): Promise<ReferralView> {
  const referrerId = decodeReferralCode(input.code);
  if (!referrerId) throw new DomainError("validation", "This referral code is not valid.", undefined, "promotions.referralCodeNotValid");
  const refereeId = input.refereeBusinessId;
  if (referrerId === refereeId) throw new DomainError("validation", "You cannot use your own referral code.", undefined, "promotions.useOwnReferralCode");
  const [ref, me] = await Promise.all([riskKeys(referrerId), riskKeys(refereeId)]);
  if (!ref.name && ref.personIds.length === 0) throw new DomainError("validation", "This referral code is not valid.", undefined, "promotions.referralCodeNotValid");
  if (me.personIds.some((p) => ref.personIds.includes(p))) throw new DomainError("validation", "You cannot use a referral code from your own account.", undefined, "promotions.useReferralCodeFromOwn");
  const flags = new Set<string>(input.extraFlags ?? []);
  if (me.phones.some((p) => ref.phones.includes(p))) flags.add("shared_phone");
  if (me.gstin && ref.gstin && me.gstin === ref.gstin) flags.add("shared_gstin");
  const reverse = await prisma.referral.findFirst({ where: { referrerBusinessId: refereeId, refereeBusinessId: referrerId } });
  if (reverse) flags.add("referral_ring");
  try {
    const row = await prisma.referral.create({ data: { referrerBusinessId: referrerId, refereeBusinessId: refereeId, code: referralCodeFor(referrerId), riskFlags: [...flags] } });
    return toView(row);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new DomainError("conflict", "A referral code has already been applied to this business.", undefined, "promotions.referralCodeAlreadyBeenApplied");
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ qualification

function quarterStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}

/**
 * The qualifying action happened for `refereeBusinessId`. Requires verification tier >= 1 (signup alone earns nothing).
 * Idempotent: only a pending referral can qualify. Starts the 7-day fraud hold. Returns the updated referral, or null when
 * nothing applied (no referral, already past pending, or not yet tier 1).
 */
export async function qualifyReferral(refereeBusinessId: string, action: ReferralAction, now = new Date()): Promise<ReferralView | null> {
  const r = await prisma.referral.findUnique({ where: { refereeBusinessId } });
  if (!r || r.status !== "pending") return null;
  const tier = (await getTrustProfiles([refereeBusinessId])).get(refereeBusinessId)?.verificationTier ?? 0;
  if (tier < 1) return null;
  const inQuarter = await prisma.referral.count({ where: { referrerBusinessId: r.referrerBusinessId, status: { in: ["qualified", "rewarded"] }, qualifiedAt: { gte: quarterStart(now) } } });
  if (inQuarter >= REFERRAL.quarterlyCap) {
    await rejectReferral(r.id, "This referrer has reached the quarterly referral limit.");
    return toView(await prisma.referral.findUniqueOrThrow({ where: { id: r.id } }));
  }
  const holdUntil = addDays(now, REFERRAL.holdDays);
  const ok = await prisma.$transaction(async (tx) => {
    const n = await tx.referral.updateMany({ where: { id: r.id, status: "pending" }, data: { status: "qualified", qualifyingAction: action, qualifiedAt: now, holdUntil } });
    if (n.count === 0) return false;
    await emit(tx, "ReferralQualified", { type: "referral", id: r.id }, { referralId: r.id, referrerBusinessId: r.referrerBusinessId, refereeBusinessId, action, holdUntil: holdUntil.toISOString() });
    return true;
  });
  return ok ? toView(await prisma.referral.findUniqueOrThrow({ where: { id: r.id } })) : null;
}

/** BusinessVerified: a referee who reached tier 1 after already publishing a listing qualifies now. */
export async function qualifyOnVerification(businessId: string, now = new Date()): Promise<ReferralView | null> {
  const r = await prisma.referral.findUnique({ where: { refereeBusinessId: businessId } });
  if (!r || r.status !== "pending") return null;
  const live = await listPublicSellerListings(businessId).catch(() => []);
  return live.length > 0 ? qualifyReferral(businessId, "listing_published", now) : null;
}

export async function rejectReferral(referralId: string, reason: string, decidedBy?: string): Promise<ReferralView> {
  const r = /^[0-9a-f-]{36}$/i.test(referralId) ? await prisma.referral.findUnique({ where: { id: referralId } }) : null;
  if (!r) throw new DomainError("not_found", "Referral not found", undefined, "promotions.referralNotFound");
  if (r.status === "rewarded" || r.status === "rejected") throw new DomainError("conflict", `This referral is already ${r.status}`);
  const why = reason.trim().slice(0, 300);
  if (!why) throw new DomainError("validation", "A reason is required (it is shown to the referrer)");
  await prisma.$transaction(async (tx) => {
    const n = await tx.referral.updateMany({ where: { id: r.id, status: { in: ["pending", "qualified"] } }, data: { status: "rejected", rejectedReason: why } });
    if (n.count === 0) return;
    await emit(tx, "ReferralRejected", { type: "referral", id: r.id }, { referralId: r.id, referrerBusinessId: r.referrerBusinessId, refereeBusinessId: r.refereeBusinessId, reason: decidedBy ? `${why} (reviewed)` : why });
  });
  return toView(await prisma.referral.findUniqueOrThrow({ where: { id: r.id } }));
}

async function reward(r: Row, now: Date): Promise<boolean> {
  const credits = REFERRAL.rewardCredits;
  // grants are idempotent per (refType, refId): a crash between the two grants or a retry can never double-pay
  await grantCredits(r.referrerBusinessId, credits, "referral", { refType: "referral", refId: `${r.id}:referrer` });
  await grantCredits(r.refereeBusinessId, credits, "referral", { refType: "referral", refId: `${r.id}:referee` });
  return prisma.$transaction(async (tx) => {
    const n = await tx.referral.updateMany({ where: { id: r.id, status: "qualified" }, data: { status: "rewarded", rewardedAt: now, rewardCredits: credits } });
    if (n.count === 0) return false;
    await emit(tx, "ReferralRewarded", { type: "referral", id: r.id }, { referralId: r.id, referrerBusinessId: r.referrerBusinessId, refereeBusinessId: r.refereeBusinessId, creditsEach: credits });
    return true;
  });
}

/** Staff release of a held or flagged referral (`referrals.review`). Still requires the hold to have elapsed unless `force`. */
export async function releaseReferral(referralId: string, opts: { force?: boolean } = {}, now = new Date()): Promise<ReferralView> {
  const r = /^[0-9a-f-]{36}$/i.test(referralId) ? await prisma.referral.findUnique({ where: { id: referralId } }) : null;
  if (!r) throw new DomainError("not_found", "Referral not found", undefined, "promotions.referralNotFound");
  if (r.status !== "qualified") throw new DomainError("conflict", "Only a qualified referral can be released", undefined, "promotions.onlyQualifiedReferralReleased");
  if (!opts.force && r.holdUntil && r.holdUntil > now) throw new DomainError("conflict", "The fraud-review hold has not finished yet.", undefined, "promotions.fraudReviewHoldNotFinished");
  await reward(r, now);
  return toView(await prisma.referral.findUniqueOrThrow({ where: { id: r.id } }));
}

/** Job: pay out qualified referrals whose hold ended AND that carry no fraud flag. Flagged ones stay for staff. */
export async function releaseDueReferrals(now = new Date()): Promise<number> {
  const due = await prisma.referral.findMany({ where: { status: "qualified", holdUntil: { lte: now } }, take: 200 });
  let n = 0;
  for (const r of due) {
    if (r.riskFlags.length > 0) continue;
    if (await reward(r, now)) n++;
  }
  return n;
}

export async function listReferralsFor(referrerBusinessId: string): Promise<ReferralView[]> {
  const rows = await prisma.referral.findMany({ where: { referrerBusinessId }, orderBy: { createdAt: "desc" }, take: 200 });
  const names = await getTrustProfiles(rows.map((r) => r.refereeBusinessId));
  return rows.map((r) => ({ ...toView(r), refereeName: names.get(r.refereeBusinessId)?.name }));
}

/** Review queue: qualified referrals with a fraud flag, plus anything held past its hold with flags (oldest first). */
export async function listReferralsForReview(opts: { limit?: number } = {}): Promise<ReferralView[]> {
  const rows = await prisma.referral.findMany({ where: { status: { in: ["qualified", "pending"] }, NOT: { riskFlags: { isEmpty: true } } }, orderBy: { createdAt: "asc" }, take: Math.min(opts.limit ?? 100, 200) });
  const names = await getTrustProfiles(rows.flatMap((r) => [r.refereeBusinessId, r.referrerBusinessId]));
  return rows.map((r) => ({ ...toView(r), refereeName: names.get(r.refereeBusinessId)?.name }));
}

export async function referralSummary(referrerBusinessId: string): Promise<{ code: string; pending: number; qualified: number; rewarded: number; rejected: number; creditsEarned: number; rewardCreditsPerSide: number; quarterlyCap: number }> {
  const rows = await prisma.referral.findMany({ where: { referrerBusinessId }, select: { status: true, rewardCredits: true } });
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    code: referralCodeFor(referrerBusinessId), pending: count("pending"), qualified: count("qualified"), rewarded: count("rewarded"), rejected: count("rejected"),
    creditsEarned: rows.reduce((a, r) => a + (r.status === "rewarded" ? (r.rewardCredits ?? 0) : 0), 0), rewardCreditsPerSide: REFERRAL.rewardCredits, quarterlyCap: REFERRAL.quarterlyCap,
  };
}
