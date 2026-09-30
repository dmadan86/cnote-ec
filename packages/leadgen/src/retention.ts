// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";

/** Deletes lead captures that never completed (started / otp_sent / abandoned) and were last touched before `before`. */
export async function purgeAbandonedCaptures(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { status: { in: ["started", "otp_sent", "abandoned"] as ("started" | "otp_sent" | "abandoned")[] }, updatedAt: { lt: before } };
  if (opts.dryRun) return prisma.leadCapture.count({ where });
  return (await prisma.leadCapture.deleteMany({ where })).count;
}
