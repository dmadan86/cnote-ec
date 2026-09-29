import { queueConsumer, type EventHandlers, type ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { deliverJob, notifyForEvent } from "./pipeline";
import { observedEvents, registerNotificationTemplates } from "./kinds";

const RETENTION_DAYS = 90;

/** Delete READ notifications older than 90 days (unread ones are kept). Returns rows deleted. */
export async function pruneReadNotifications(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.notification.deleteMany({ where: { readAt: { lt: cutoff } } });
  return count;
}

// Register template keys at import so the admin editor and worker see them. Guarded: this module is also
// imported by Next apps, which must never fail to load because of registry state.
try {
  registerNotificationTemplates();
} catch (err) {
  console.error("[notifications] template registration deferred", err);
}

const handlers = Object.fromEntries(observedEvents().map((type) => [type, (event: never) => notifyForEvent(event)])) as EventHandlers;

export const worker: ModuleWorker = {
  name: "notifications",
  handlers,
  jobs: [{ name: "prune-read", everyMs: 6 * 3_600_000, run: async () => void (await pruneReadNotifications()) }],
  queues: [queueConsumer("notification.deliver", async (msg) => deliverJob(msg.payload), 2)],
};
