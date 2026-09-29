import type { NotificationView } from "@cnote/notifications";
import { Badge, Button, Card, EmptyState, LinkTabs, buttonClasses } from "@cnote/ui";
import Link from "next/link";
import { markAllReadAction, markReadAction } from "./actions";

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export function Inbox({ items, nextCursor, unreadOnly, unread }: { items: NotificationView[]; nextCursor: string | null; unreadOnly: boolean; unread: number }) {
  const page = (cursor: string) => `/notifications?${unreadOnly ? "filter=unread&" : ""}cursor=${cursor}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LinkTabs
          label="Filter notifications"
          variant="underline"
          items={[
            { href: "/notifications", label: "All", active: !unreadOnly },
            { href: "/notifications?filter=unread", label: `Unread${unread > 0 ? ` (${unread})` : ""}`, active: unreadOnly },
          ]}
        />
        <div className="flex items-center gap-2">
          <Link href="/notifications/preferences" className={buttonClasses("outline", "sm")}>Preferences</Link>
          {unread > 0 ? (
            <form action={markAllReadAction}><Button type="submit" variant="outline-brand" size="sm">Mark all as read</Button></form>
          ) : null}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState title={unreadOnly ? "You are all caught up" : "No notifications yet"} description="We will let you know here when something needs your attention." />
      ) : (
        <ul className="grid gap-2">
          {items.map((n) => (
            <li key={n.id}>
              <Card className={n.read ? "" : "border-brand-100 bg-brand-50/40"}>
                <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                      {n.href ? <Link href={n.href} className="hover:underline focus-visible:underline">{n.title}</Link> : n.title}
                      {n.read ? null : <Badge tone="brand">New</Badge>}
                    </p>
                    {n.body ? <p className="whitespace-pre-line text-sm text-muted">{n.body}</p> : null}
                    <p className="text-xs text-muted"><time dateTime={n.createdAt}>{fmt.format(new Date(n.createdAt))}</time></p>
                  </div>
                  {n.read ? null : (
                    <form action={markReadAction} className="shrink-0">
                      <input type="hidden" name="id" value={n.id} />
                      <Button type="submit" variant="ghost" size="sm" aria-label={`Mark "${n.title}" as read`}>Mark as read</Button>
                    </form>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? <Link href={page(nextCursor)} className="inline-block text-sm font-medium text-brand-700 hover:underline">Older notifications →</Link> : null}
    </div>
  );
}
