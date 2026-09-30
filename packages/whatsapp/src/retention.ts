import { prisma } from "@cnote/db";
import { DAY_MS, RETENTION_DAYS } from "./config";

/**
 * Retention (DPDP): message bodies and media keys older than `before` are removed; the rows stay for delivery
 * accounting. Default cut-off is 30 days. Returns the number of rows scrubbed.
 */
export async function purgeWhatsAppMessages(before: Date = new Date(Date.now() - RETENTION_DAYS * DAY_MS)): Promise<number> {
  const r = await prisma.whatsAppMessage.updateMany({
    where: { createdAt: { lt: before }, OR: [{ body: { not: null } }, { mediaKey: { not: null } }] },
    data: { body: null, mediaKey: null },
  });
  return r.count;
}
