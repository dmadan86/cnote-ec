// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";
import { getMediaStore } from "@cnote/media";

export const RETENTION_TOMBSTONE = "[deleted per retention policy]";

/**
 * Tombstones the BODY of messages in conversations that have been inactive since `before` (no message at or
 * after it). Metadata (sender, timestamps, language) and all domain events are kept for analytics/audit.
 * Idempotent: already-tombstoned messages are skipped. `dryRun` only counts. Returns rows affected.
 */
export async function purgeInactiveConversationMessages(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = {
    createdAt: { lt: before },
    body: { not: RETENTION_TOMBSTONE },
    conversation: { messages: { none: { createdAt: { gte: before } } } },
  };
  if (opts.dryRun) return prisma.message.count({ where });
  const r = await prisma.message.updateMany({ where, data: { body: RETENTION_TOMBSTONE } });
  return r.count;
}

const BATCH = 200;
type EndedStatus = "closed" | "rejected" | "unmatched";

/**
 * RFQ and quote attachments (drawings, specs; personal and commercial data) once the requirement has been over for the
 * window: the quote deadline `expiresAt` passed before `before`, or (legacy rows without a deadline) the requirement was
 * created before `before` and ended (closed / rejected / unmatched). Deletes the bytes from the private bucket, then the
 * rows. Conversations, quotes and domain events keep their own retention. Idempotent. `dryRun` only counts.
 */
export async function purgeEndedEnquiryAttachments(before: Date, opts: { dryRun?: boolean; orderGraceDays?: number } = {}): Promise<number> {
  const where = {
    enquiry: {
      OR: [
        { expiresAt: { lt: before } },
        { expiresAt: null, createdAt: { lt: before }, status: { in: ["closed", "rejected", "unmatched"] as EndedStatus[] } },
      ],
    },
  };
  // A requirement that became an order may still be the subject of a dispute (3-year limitation, ADR-013): its drawings
  // are kept until `orderGraceDays` (default 730) beyond the window, measured from the order.
  const orderKeepAfter = new Date(before.getTime() - (opts.orderGraceDays ?? 730) * 86_400_000);
  const store = getMediaStore("private");
  let purged = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.enquiryAttachment.findMany({
      where, select: { id: true, key: true, enquiryId: true }, take: BATCH, orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) return purged;
    cursor = rows[rows.length - 1]!.id;
    const held = new Set(
      (await prisma.order.findMany({ where: { enquiryId: { in: [...new Set(rows.map((r) => r.enquiryId))] }, createdAt: { gte: orderKeepAfter } }, select: { enquiryId: true } })).map((o) => o.enquiryId),
    );
    const due = rows.filter((r) => !held.has(r.enquiryId));
    if (opts.dryRun) { purged += due.length; continue; }
    if (!due.length) continue;
    await Promise.all(due.map((r) => store.delete(r.key).catch((e) => console.warn("[enquiry] retention: could not delete", r.key, e instanceof Error ? e.message : e))));
    purged += (await prisma.enquiryAttachment.deleteMany({ where: { id: { in: due.map((r) => r.id) } } })).count;
  }
}

/** Quarantined (malware-flagged) uploads: the bytes are deleted after the window; the row stays as the audit record with `purgedAt`. */
export async function purgeAttachmentQuarantine(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { detectedAt: { lt: before }, purgedAt: null };
  if (opts.dryRun) return prisma.attachmentQuarantine.count({ where });
  const store = getMediaStore("private");
  let purged = 0;
  for (;;) {
    const rows = await prisma.attachmentQuarantine.findMany({ where, select: { id: true, key: true }, take: BATCH, orderBy: { detectedAt: "asc" } });
    if (!rows.length) return purged;
    await Promise.all(rows.map((r) => store.delete(r.key).catch((e) => console.warn("[enquiry] retention: could not delete", r.key, e instanceof Error ? e.message : e))));
    purged += (await prisma.attachmentQuarantine.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { purgedAt: new Date() } })).count;
  }
}
