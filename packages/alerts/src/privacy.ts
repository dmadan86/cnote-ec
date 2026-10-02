// DPDP (ADR-010): everything this module holds about a person can be exported, erased, and ages out.
import { prisma } from "@cnote/db";

/** Access right: follows, saved searches and alert opt-ins. (Dispatch rows are an internal dedupe ledger and carry no content.) */
export async function exportAlertsData(personId: string): Promise<Record<string, unknown>> {
  const [follows, searches, settings] = await Promise.all([
    prisma.supplierFollow.findMany({ where: { personId }, orderBy: { createdAt: "asc" } }),
    prisma.savedSearch.findMany({ where: { personId }, orderBy: { createdAt: "asc" } }),
    prisma.alertSettings.findUnique({ where: { personId } }),
  ]);
  return {
    followedSuppliers: follows.map((f) => ({ businessId: f.businessId, followedAt: f.createdAt })),
    savedSearches: searches.map((s) => ({ name: s.name, query: s.query, filters: s.filters, sort: s.sort, frequency: s.frequency, lastRunAt: s.lastRunAt, createdAt: s.createdAt })),
    alertSettings: settings ? { priceDrop: settings.priceDrop, backInStock: settings.backInStock, followedDigest: settings.followedDigest } : null,
  };
}

/** Erasure: removes every row about the person. Idempotent. */
export async function eraseAlertsData(personId: string): Promise<void> {
  await prisma.$transaction([
    prisma.supplierFollow.deleteMany({ where: { personId } }),
    prisma.savedSearch.deleteMany({ where: { personId } }),
    prisma.alertSettings.deleteMany({ where: { personId } }),
    prisma.alertDispatch.deleteMany({ where: { personId } }),
  ]);
}

/** Storage limitation: the dedupe ledger only needs to outlive event redelivery. Called by @cnote/compliance's retention registry. */
export async function purgeOldDispatches(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { createdAt: { lt: before } };
  if (opts.dryRun) return prisma.alertDispatch.count({ where });
  return (await prisma.alertDispatch.deleteMany({ where })).count;
}

/** Registry-shaped alias of exportAlertsData (security audit M10). */
export const exportPersonalData = (personId: string) => exportAlertsData(personId);
