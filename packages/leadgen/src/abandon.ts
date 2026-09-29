import { prisma } from "@cnote/db";

export const ABANDON_AFTER_MS = 30 * 60_000;

/**
 * Marks captures that never verified within 30 minutes as abandoned. A follow-up is queued ONLY where the buyer
 * ticked the separate follow-up consent; this phase just logs the intent (no sending, no phone in the log:
 * only a phone hash exists before verification, so nothing is sendable yet). Returns counts.
 */
export async function sweepAbandoned(now = new Date()): Promise<{ abandoned: number; followUpsQueued: number }> {
  const cutoff = new Date(now.getTime() - ABANDON_AFTER_MS);
  const stale = await prisma.leadCapture.findMany({
    where: { status: { in: ["started", "otp_sent"] }, updatedAt: { lt: cutoff } },
    select: { id: true, followUpConsent: true, trigger: true, phoneHash: true },
    take: 500,
  });
  if (stale.length === 0) return { abandoned: 0, followUpsQueued: 0 };
  const r = await prisma.leadCapture.updateMany({
    where: { id: { in: stale.map((s) => s.id) }, status: { in: ["started", "otp_sent"] } },
    data: { status: "abandoned" },
  });
  const followUps = stale.filter((s) => s.followUpConsent && s.phoneHash);
  for (const f of followUps) console.info(`[leadgen] follow-up intent (consented) capture=${f.id} trigger=${f.trigger}`);
  return { abandoned: r.count, followUpsQueued: followUps.length };
}
