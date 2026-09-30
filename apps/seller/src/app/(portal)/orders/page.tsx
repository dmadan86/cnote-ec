import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Card, CardBody, EmptyState, Money, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { OrderStatusBadge } from "@/features/orders/status";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("orders"))("metaTitle") };
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const session = await requireSeller("/orders");
  const t = await getTranslations("orders");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const res = await load(() => enquiry.listOrders(actorOf(session), { role: "seller", cursor }));
  if (!res.ok) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{res.error}</Alert></div>;
  const { items, nextCursor } = res.data;
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {items.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} action={<Link href="/leads" className={buttonClasses("outline", "md", "min-h-11")}>{t("emptyAction")}</Link>} />
      ) : (
        <ul className="grid gap-3">
          {items.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{o.enquiryTitle}</p>
                      <p className="mt-0.5 text-xs text-muted">{o.counterparty.name} · {formatDate(o.createdAt, locale)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {o.totalPaise !== null ? <Money paise={o.totalPaise} /> : null}
                      <OrderStatusBadge status={o.status} />
                    </div>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? <nav aria-label={t("paginationLabel")}><Link href={`/orders?cursor=${nextCursor}`} className={buttonClasses("outline", "md", "min-h-11")}>{t("older")}</Link></nav> : null}
    </div>
  );
}
