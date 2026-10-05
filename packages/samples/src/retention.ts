// DPDP (ADR-010): ship-to details, notes and evaluation photos are personal data. Registered with @cnote/compliance's retention registry.
import { prisma } from "@cnote/db";
import { FINAL_STATUSES } from "./state";
import { photoStore } from "./ports";

const BLANK = { shipName: null, shipPhone: null, shipLine1: null, shipLine2: null, shipCity: null, shipPincode: null, buyerNote: null, evaluationNotes: null, paymentNote: null, declineNote: null } as const;

/** Deletes the stored photos of one request and blanks its personal content. Statuses, reasons, amounts and timestamps stay (trust + audit). */
async function scrub(id: string): Promise<void> {
  const media = await prisma.sampleMedia.findMany({ where: { sampleId: id, purgedAt: null }, select: { id: true, key: true } });
  for (const m of media) await photoStore().delete(m.key).catch((err) => console.error("[samples] photo purge failed", err instanceof Error ? err.message : err));
  const now = new Date();
  await prisma.$transaction([
    prisma.sampleMedia.updateMany({ where: { sampleId: id, purgedAt: null }, data: { purgedAt: now } }),
    prisma.sampleRequest.update({ where: { id }, data: { ...BLANK, personalDataPurgedAt: now } }),
  ]);
}

/**
 * Purges the personal content of requests that reached a final status before `before`. Idempotent. `dryRun` only counts.
 * Returns the number of requests purged.
 */
export async function purgeClosedSamplePersonalData(before: Date, opts: { dryRun?: boolean; limit?: number } = {}): Promise<number> {
  const where = { status: { in: FINAL_STATUSES }, updatedAt: { lt: before }, personalDataPurgedAt: null };
  if (opts.dryRun) return prisma.sampleRequest.count({ where });
  const due = await prisma.sampleRequest.findMany({ where, select: { id: true }, take: opts.limit ?? 500 });
  for (const { id } of due) await scrub(id);
  return due.length;
}

/**
 * DPDP erasure (ADR-010): everything the person gave us is removed now, whatever the request's status. The row, its status history
 * and the structured facts remain (the counterparty's record of the transaction), without the person's data.
 */
export async function erasePersonSamples(personId: string): Promise<number> {
  const rows = await prisma.sampleRequest.findMany({ where: { buyerPersonId: personId, personalDataPurgedAt: null }, select: { id: true } });
  for (const { id } of rows) await scrub(id);
  return rows.length;
}
