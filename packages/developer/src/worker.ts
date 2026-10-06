import { emit, type ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { revokeAllApiKeysForPerson } from "./keys";
import { flushApiKeyUsage } from "./usage";

const DAY = 86_400_000;

/**
 * Notify the owners of active keys that expire within 7 days, and again on the day of expiry (within 24h). Each threshold fires
 * once per key: the marker column is set in the same transaction that emits `ApiKeyExpiring` (observed by @cnote/notifications,
 * which renders the DB template and sends through the email pipeline), so a re-run never re-sends. A key already inside the last
 * 24h gets only the expiry-day notice (both markers set) instead of two emails in a row. Returns the number of notices emitted.
 */
export async function notifyExpiringKeys(now = new Date()): Promise<number> {
  const rows = await prisma.apiKey.findMany({
    where: {
      revokedAt: null,
      expiresAt: { gt: now, lte: new Date(now.getTime() + 7 * DAY) },
      OR: [{ expiryNotice7dAt: null }, { expiryNoticeDayAt: null }],
    },
    select: { id: true, personId: true, name: true, prefix: true, expiresAt: true, expiryNotice7dAt: true, expiryNoticeDayAt: true },
  });
  let sent = 0;
  for (const r of rows) {
    if (!r.expiresAt) continue;
    const expiresAt = r.expiresAt;
    const threshold = expiresAt.getTime() - now.getTime() <= DAY ? "expiry_day" : "7d";
    if (threshold === "7d" && r.expiryNotice7dAt) continue;
    if (threshold === "expiry_day" && r.expiryNoticeDayAt) continue;
    const emitted = await prisma.$transaction(async (tx) => {
      // claim the marker first (conditional update) so two workers can't both emit
      const claimed = await tx.apiKey.updateMany({
        where: { id: r.id, revokedAt: null, ...(threshold === "7d" ? { expiryNotice7dAt: null } : { expiryNoticeDayAt: null }) },
        data: threshold === "7d" ? { expiryNotice7dAt: now } : { expiryNoticeDayAt: now, ...(r.expiryNotice7dAt ? {} : { expiryNotice7dAt: now }) },
      });
      if (claimed.count === 0) return false;
      await emit(tx, "ApiKeyExpiring", { type: "ApiKey", id: r.id }, {
        keyId: r.id, personId: r.personId, name: r.name, prefix: r.prefix, expiresAt: expiresAt.toISOString(), threshold,
      });
      return true;
    });
    if (emitted) sent++;
  }
  return sent;
}

export const worker: ModuleWorker = {
  name: "developer",
  handlers: {
    DataErasureRequested: async (e) => {
      await revokeAllApiKeysForPerson(e.payload.personId);
    },
  },
  jobs: [
    { name: "developer.flush-usage", everyMs: 5 * 60_000, run: async () => void (await flushApiKeyUsage()) },
    { name: "developer.expiring-keys", everyMs: 24 * 3_600_000, run: async () => void (await notifyExpiringKeys()) },
  ],
};
