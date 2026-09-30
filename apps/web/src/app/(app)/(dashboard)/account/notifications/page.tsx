import { listNotifications, unreadCount } from "@cnote/notifications";
import { Alert, Container, PageHeader } from "@cnote/ui";
import { requireSession } from "@cnote/next-kit";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getRequestLocale } from "@/lib/request-locale";
import { Inbox } from "@/features/notifications/inbox";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("notifications") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const unreadOnly = first(sp.filter) === "unread";
  const cursor = first(sp.cursor);
  const s = await requireSession("/account/notifications");
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "notif" });
  const data = await Promise.all([
    listNotifications(s.personId, "web", { unreadOnly, cursor, limit: 20 }),
    unreadCount(s.personId, "web"),
  ]).catch((err) => {
    console.error("[notifications] inbox load failed", err);
    return null;
  });
  const body = !data ? (
    <Alert tone="danger">{t("loadError")}</Alert>
  ) : (
    <Inbox items={data[0].items} nextCursor={data[0].nextCursor} unreadOnly={unreadOnly} unread={data[1]} locale={locale} />
  );
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("title")} description={t("description")} />
      {body}
    </Container>
  );
}
