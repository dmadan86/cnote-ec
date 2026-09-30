// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";

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
