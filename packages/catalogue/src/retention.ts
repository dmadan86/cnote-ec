// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
// Listing versions are audit history and are deliberately NOT purged.
import { prisma } from "@cnote/db";
import { purgeDeletedListingImages } from "./images";

const IMAGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // purgeDeletedListingImages' built-in grace

/**
 * Removes bytes + rows of listing images soft-deleted before `before`. Reuses the image purge job (which applies
 * its own 30-day grace, compensated here so `before` is the effective cutoff). `dryRun` only counts.
 */
export async function purgeSoftDeletedImages(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  if (opts.dryRun) return prisma.listingImage.count({ where: { deletedAt: { lt: before } } });
  let total = 0;
  for (;;) {
    const n = await purgeDeletedListingImages(new Date(before.getTime() + IMAGE_GRACE_MS));
    total += n;
    if (n === 0) return total;
  }
}
