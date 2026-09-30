// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";

/** Deletes in-app notifications READ before `before` (unread ones are kept). `dryRun` only counts. */
export async function purgeReadNotifications(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { readAt: { lt: before } };
  if (opts.dryRun) return prisma.notification.count({ where });
  return (await prisma.notification.deleteMany({ where })).count;
}
