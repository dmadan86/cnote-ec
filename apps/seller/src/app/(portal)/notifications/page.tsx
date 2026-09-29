import { listNotifications, unreadCount } from "@cnote/notifications";
import { Alert, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { Inbox } from "@/features/notifications/inbox";

export const metadata = { title: "Notifications" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const unreadOnly = first(sp.filter) === "unread";
  const cursor = first(sp.cursor);
  const s = await requireSeller("/notifications");
  const data = await Promise.all([
    listNotifications(s.personId, "seller", { unreadOnly, cursor, limit: 20 }),
    unreadCount(s.personId, "seller"),
  ]).catch((err) => {
    console.error("[notifications] inbox load failed", err);
    return null;
  });
  const body = !data ? (
    <Alert tone="danger">We could not load your notifications right now. Please try again in a moment.</Alert>
  ) : (
    <Inbox items={data[0].items} nextCursor={data[0].nextCursor} unreadOnly={unreadOnly} unread={data[1]} />
  );
  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="Updates about your leads, messages and account." />
      {body}
    </div>
  );
}
