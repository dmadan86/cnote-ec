import { cached, redis } from "@cnote/core";
import type { NotificationApp } from "./types";

const key = (personId: string, app: NotificationApp) => `notif:unread:${personId}:${app}`;

export const cachedUnread = (personId: string, app: NotificationApp, load: () => Promise<number>) => cached(key(personId, app), 300, load);

/** Best effort: a Redis outage must never fail a notification write. */
export async function bustUnread(personId: string, app?: NotificationApp): Promise<void> {
  try {
    await redis.del(...(app ? [key(personId, app)] : (["web", "seller", "admin"] as const).map((a) => key(personId, a))));
  } catch (err) {
    console.error("[notifications] unread cache bust failed", err);
  }
}
