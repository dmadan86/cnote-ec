import type { ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { revokeAllApiKeysForPerson } from "./keys";
import { flushApiKeyUsage } from "./usage";

/** Log active keys expiring within 7 days. TODO(notifications): email the owner once templates exist. */
export async function logExpiringKeys(now = new Date()): Promise<number> {
  const rows = await prisma.apiKey.findMany({
    where: { revokedAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + 7 * 86_400_000) } },
    select: { id: true, personId: true, prefix: true, expiresAt: true },
  });
  for (const r of rows) console.log(`[developer] api key ${r.prefix} (${r.id}) of person ${r.personId} expires ${r.expiresAt?.toISOString()}`);
  return rows.length;
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
    { name: "developer.expiring-keys", everyMs: 24 * 3_600_000, run: async () => void (await logExpiringKeys()) },
  ],
};
