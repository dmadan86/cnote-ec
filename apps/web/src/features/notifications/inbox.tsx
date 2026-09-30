import type { NotificationView } from "@cnote/notifications";
import { Badge, Button, Card, EmptyState, LinkTabs, buttonClasses } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { formatDate, type Locale } from "@/i18n/config";
import { markAllReadAction, markReadAction } from "./actions";

export async function Inbox({ items, nextCursor, unreadOnly, unread, locale = "en" }: { items: NotificationView[]; nextCursor: string | null; unreadOnly: boolean; unread: number; locale?: Locale }) {
  const t = await getTranslations({ locale, namespace: "notif" });
  const fmt = { format: (d: Date) => formatDate(d, locale, { dateStyle: "medium", timeStyle: "short" }) };
  const page = (cursor: string) => `/account/notifications?${unreadOnly ? "filter=unread&" : ""}cursor=${cursor}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LinkTabs
          label={t("filterLabel")}
          variant="underline"
          items={[
            { href: "/account/notifications", label: t("all"), active: !unreadOnly },
            { href: "/account/notifications?filter=unread", label: unread > 0 ? t("unreadCount", { count: unread }) : t("unread"), active: unreadOnly },
          ]}
        />
        <div className="flex items-center gap-2">
          <Link href="/account/notifications/preferences" className={buttonClasses("outline", "sm")}>{t("preferences")}</Link>
          {unread > 0 ? (
            <form action={markAllReadAction}><Button type="submit" variant="outline-brand" size="sm">{t("markAll")}</Button></form>
          ) : null}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState title={unreadOnly ? t("caughtUp") : t("none")} description={t("noneDescription")} />
      ) : (
        <ul className="grid gap-2">
          {items.map((n) => (
            <li key={n.id}>
              <Card className={n.read ? "" : "border-brand-100 bg-brand-50/40"}>
                <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                      {n.href ? <Link href={n.href} className="hover:underline focus-visible:underline">{n.title}</Link> : n.title}
                      {n.read ? null : <Badge tone="brand">{t("new")}</Badge>}
                    </p>
                    {n.body ? <p className="whitespace-pre-line text-sm text-muted">{n.body}</p> : null}
                    <p className="text-xs text-muted"><time dateTime={n.createdAt}>{fmt.format(new Date(n.createdAt))}</time></p>
                  </div>
                  {n.read ? null : (
                    <form action={markReadAction} className="shrink-0">
                      <input type="hidden" name="id" value={n.id} />
                      <Button type="submit" variant="ghost" size="sm" aria-label={t("markReadAria", { title: n.title })}>{t("markRead")}</Button>
                    </form>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? <Link href={page(nextCursor)} className="inline-block text-sm font-medium text-brand-700 hover:underline">{t("older")}</Link> : null}
    </div>
  );
}
