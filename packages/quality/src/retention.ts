// DPDP retention (ADR-010): dispatch photos are deleted from the private bucket after QUALITY_MEDIA_RETENTION_DAYS; the row
// (hash, dimensions, results) stays so the advisory evidence trail survives.
import { prisma } from "@cnote/db";
import { getMediaStore } from "@cnote/media";

/** Deletes objects for media created before `before` and marks them purged. Idempotent. `dryRun` only counts. Returns rows affected. */
export async function purgeOldQualityMedia(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { createdAt: { lt: before }, purgedAt: null };
  if (opts.dryRun) return prisma.qualityCheckMedia.count({ where });
  const store = getMediaStore("private");
  let total = 0;
  for (;;) {
    const rows = await prisma.qualityCheckMedia.findMany({ where, take: 200, select: { id: true, key: true } });
    if (!rows.length) return total;
    await Promise.all(rows.map((r) => store.delete(r.key)));
    const { count } = await prisma.qualityCheckMedia.updateMany({ where: { id: { in: rows.map((r) => r.id) }, purgedAt: null }, data: { purgedAt: new Date() } });
    total += count;
  }
}
