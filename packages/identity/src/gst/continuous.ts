// Continuous verification (ADR-003): every GST-verified business is re-checked about monthly, spread across the
// month by a stable hash of its id (so the provider bill and rate limits are flat). A Cancelled/Suspended GSTIN
// revokes the T1 tier: badge off (trust recompute), TrustScoreChanged, and BusinessVerified{tier:0, kind:"gstin_revoked"}
// as the notification-worthy event (a dedicated GstStatusChanged catalogue entry would be cleaner: see report).
import { emit, type ScheduledJob } from "@cnote/core";
import { prisma } from "@cnote/db";
import { bustSellerCaches } from "../business";
import { GstnProviderError, getGstnProvider, type GstnRecord, type GstnStatus } from "../gstin";

const DAY_MS = 86_400_000;
const RECHECK_EVERY_DAYS = 30;

/** Stable 0..29 bucket per business. */
export function recheckBucket(businessId: string): number {
  let h = 0;
  for (const ch of businessId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % RECHECK_EVERY_DAYS;
}
/** Due when the last check is ≥30d old and it is this business's day in the cycle; overdue (≥40d) is always due. */
export function isRecheckDue(businessId: string, lastCheckedAt: Date | null, now = new Date()): boolean {
  if (!lastCheckedAt) return true;
  const age = (now.getTime() - lastCheckedAt.getTime()) / DAY_MS;
  if (age < RECHECK_EVERY_DAYS) return false;
  return age >= RECHECK_EVERY_DAYS + 10 || Math.floor(now.getTime() / DAY_MS) % RECHECK_EVERY_DAYS === recheckBucket(businessId);
}

export interface RecheckResult {
  businessId: string;
  status: GstnStatus | "not_found" | "unavailable";
  revoked: boolean;
}

/** Re-checks one business's GST status; revokes the badge if the GSTIN is no longer Active. */
export async function recheckGstStatus(businessId: string, now = new Date()): Promise<RecheckResult | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, gstin: true, legalName: true, name: true, verificationTier: true } });
  if (!b?.gstin) return null;
  const provider = getGstnProvider();
  let record: GstnRecord | null;
  try {
    record = await provider.lookup(b.gstin, { businessName: b.legalName ?? b.name });
  } catch (err) {
    if (err instanceof GstnProviderError) return { businessId, status: "unavailable", revoked: false }; // retry tomorrow (still due)
    throw err;
  }
  const status: GstnStatus | "not_found" = record?.status ?? "not_found";
  const active = status === "Active";
  const revoke = !active && b.verificationTier >= 1;
  await prisma.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: businessId },
      data: { gstStatus: status === "not_found" ? "Inactive" : status, gstLastCheckedAt: now, ...(active ? {} : { gstVerifiedAt: null }), ...(revoke ? { verificationTier: 0 } : {}) },
    });
    await tx.verificationRecord.create({
      data: { businessId, tier: 1, kind: "gstin", status: active ? "passed" : "failed", provider: provider.name, details: JSON.parse(JSON.stringify({ gstin: b.gstin, recheck: true, status, snapshot: record, checkedAt: now.toISOString() })) },
    });
    if (revoke) await emit(tx, "BusinessVerified", { type: "Business", id: businessId }, { businessId, tier: 0, kind: "gstin_revoked" });
  });
  if (revoke) {
    const { recomputeTrust } = await import("../trust-worker"); // lazy: trust-worker imports this module's jobs
    await recomputeTrust(businessId); // badge off + TrustScoreChanged
  }
  await bustSellerCaches(businessId);
  return { businessId, status, revoked: revoke };
}

/** One daily pass: rechecks the businesses due today (paged). Returns how many were checked / revoked. */
export async function runGstRecheck(now = new Date(), maxPerRun = 500): Promise<{ checked: number; revoked: number }> {
  let cursor: string | undefined;
  let checked = 0, revoked = 0;
  for (;;) {
    const page = await prisma.business.findMany({
      where: { gstin: { not: null }, verificationTier: { gte: 1 } },
      select: { id: true, gstLastCheckedAt: true },
      orderBy: { id: "asc" }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    for (const b of page) {
      if (checked >= maxPerRun) return { checked, revoked };
      if (!isRecheckDue(b.id, b.gstLastCheckedAt, now)) continue;
      const r = await recheckGstStatus(b.id, now);
      if (r && r.status !== "unavailable") checked++;
      if (r?.revoked) revoked++;
    }
    cursor = page[page.length - 1]!.id;
  }
  return { checked, revoked };
}

export const gstWorkerJobs: ScheduledJob[] = [
  { name: "identity.gst-recheck", everyMs: DAY_MS, run: async () => void (await runGstRecheck()) },
];
