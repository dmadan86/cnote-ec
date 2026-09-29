import { currentSession } from "@cnote/next-kit";
import { unreadCount } from "@cnote/notifications";
import { Bell } from "lucide-react";
import Link from "next/link";

/**
 * Bell with an unread badge, linking to the inbox. Server component: renders nothing when signed out.
 * The count is Redis-cached; a cache/DB failure degrades to "no badge" instead of breaking the header.
 */
export async function NotificationBell({ className }: { className?: string }) {
  const session = await currentSession();
  if (!session) return null;
  const count = await unreadCount(session.personId, "web").catch(() => 0);
  const label = count > 0 ? `Notifications, ${count} unread` : "Notifications";
  return (
    <Link
      href="/account/notifications"
      aria-label={label}
      className={`relative inline-flex size-10 items-center justify-center rounded-full text-ink transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${className ?? ""}`}
    >
      <Bell className="size-5" aria-hidden />
      {count > 0 ? (
        <span aria-hidden className="absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
