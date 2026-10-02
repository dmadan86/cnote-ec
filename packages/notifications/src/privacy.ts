// DPDP access right (ADR-010): in-app notifications and channel preferences. Registered with @cnote/compliance's export registry.
import { EXPORT_TAKE, exportCollection, type PersonalExport } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string): Promise<PersonalExport> {
  const [notifications, preferences] = await Promise.all([
    prisma.notification.findMany({
      where: { personId }, orderBy: { createdAt: "desc" }, take: EXPORT_TAKE,
      select: { id: true, businessId: true, kind: true, title: true, body: true, href: true, app: true, readAt: true, createdAt: true },
    }),
    prisma.notificationPreference.findMany({ where: { personId } }),
  ]);
  return { notifications: exportCollection(notifications), notificationPreferences: preferences };
}
