import { listOrders } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Card, CardBody, Container, EmptyState, Money, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { OrderStatusBadge } from "@/features/orders/status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("orders") };
}

export default async function BuyerOrdersPage(props: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await props.searchParams;
  const s = await requireBusiness("/buyer/orders");
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "buyer" });
  const date = { format: (d: Date) => formatDate(d, locale, { day: "numeric", month: "short", year: "numeric" }) };
  const page = await listOrders(actorOf(s), { role: "buyer", cursor });
  return (
    <Container className="py-8">
      <PageHeader title={t("ordersTitle")} description={t("ordersDescription")} />
      <div className="mt-6">
        {page.items.length === 0 ? (
          <EmptyState title={t("ordersEmptyTitle")} description={t("ordersEmptyDescription")} action={<Link href="/buyer/enquiries" className={buttonClasses("outline")}>{t("enquiriesTitle")}</Link>} />
        ) : (
          <ul className="flex flex-col gap-3">
            {page.items.map((o) => (
              <li key={o.id}>
                <Link href={`/buyer/orders/${o.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                  <Card className="transition-colors hover:border-brand-600">
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{o.enquiryTitle}</p>
                        <p className="mt-0.5 text-xs text-muted">{o.counterparty.name} · {date.format(new Date(o.createdAt))}</p>
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
        {page.nextCursor ? (
          <nav aria-label={t("ordersPagination")} className="mt-6">
            <Link href={`/buyer/orders?cursor=${page.nextCursor}`} className={buttonClasses("outline")}>{t("olderOrders")}</Link>
          </nav>
        ) : null}
      </div>
    </Container>
  );
}
