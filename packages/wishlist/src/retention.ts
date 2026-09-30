// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";

/** Deletes empty, non-default wishlists untouched since before `before` (default lists are recreated lazily). */
export async function purgeStaleEmptyWishlists(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { isDefault: false, updatedAt: { lt: before }, items: { none: {} } };
  if (opts.dryRun) return prisma.wishlist.count({ where });
  return (await prisma.wishlist.deleteMany({ where })).count;
}
