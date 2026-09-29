// Read API for the bell, inbox and preferences pages. Rows are per person; `app` scopes the inbox.
import { prisma } from "@cnote/db";
import { bustUnread, cachedUnread } from "./cache";
import type { NotificationApp, NotificationView } from "./types";

export interface ListOptions {
  unreadOnly?: boolean;
  /** id of the last item of the previous page */
  cursor?: string;
  limit?: number;
}

/** Newest first. */
export async function listNotifications(personId: string, app: NotificationApp, opts: ListOptions = {}): Promise<{ items: NotificationView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = await prisma.notification.findMany({
    where: { personId, app, ...(opts.unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((n) => ({
      id: n.id, kind: n.kind, title: n.title, body: n.body, href: n.href, app: n.app as NotificationApp,
      businessId: n.businessId, read: n.readAt !== null, createdAt: n.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

/** Redis-cached (busted on create and on read). */
export function unreadCount(personId: string, app: NotificationApp): Promise<number> {
  return cachedUnread(personId, app, () => prisma.notification.count({ where: { personId, app, readAt: null } }));
}

/** Mark specific notifications (or all in this app) as read. Only the person's own rows are touched. Returns the count changed. */
export async function markRead(personId: string, ids: string[] | "all", app: NotificationApp): Promise<number> {
  if (ids !== "all" && ids.length === 0) return 0;
  const { count } = await prisma.notification.updateMany({
    where: { personId, app, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
    data: { readAt: new Date() },
  });
  if (count > 0) await bustUnread(personId, app);
  return count;
}
