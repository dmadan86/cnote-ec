import { istDate, listBuyerPayables, purchaseOrdersEnabled, type PayablesFilter } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, Container, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { DueBadge, Row, day, inr } from "@/features/purchase-orders/po-view";
import { PayForm } from "@/features/purchase-orders/po-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "po" });
  return { title: t("payablesMetaTitle") };
}

const FILTERS: PayablesFilter[] = ["open", "overdue", "paid", "all"];

export default async function BuyerPayablesPage(props: { searchParams: Promise<{ filter?: string; cursor?: string }> }) {
  const sp = await props.searchParams;
  const filter = FILTERS.find((f) => f === sp.filter) ?? "open";
  const s = await requireBusiness("/buyer/payables");
  if (!purchaseOrdersEnabled()) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "po.payables" });
  const now = new Date();
  const page = await listBuyerPayables(actorOf(s), { filter, cursor: sp.cursor }, now);
  const today = istDate(now);
  const sum = page.summary;
  return (
    <Container className="py-8">
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="mt-6 flex flex-col gap-5">
        <div role="group" aria-label={t("summaryLabel")} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card><CardBody><dl><Row k={t("open")} v={<><strong className="text-lg">{sum.openCount}</strong> · {inr(sum.openPaise)}</>} /></dl></CardBody></Card>
          <Card><CardBody><dl><Row k={t("overdue")} v={<><strong className="text-lg">{sum.overdueCount}</strong> · {inr(sum.overduePaise)}</>} /></dl></CardBody></Card>
          <Card><CardBody><dl><Row k={t("dueSoon")} v={<strong className="text-lg">{sum.dueSoonCount}</strong>} /></dl></CardBody></Card>
          <Card><CardBody><dl><Row k={t("msmeOpen")} v={<strong className="text-lg">{sum.msmeOpenCount}</strong>} /></dl></CardBody></Card>
        </div>
        <LinkTabs
          label={t("tabsLabel")}
          linkComponent={Link}
          items={FILTERS.map((f) => ({ href: f === "open" ? "/buyer/payables" : `/buyer/payables?filter=${f}`, label: t(`tab.${f}`), active: f === filter }))}
        />
        {page.items.length === 0 ? (
          <EmptyState title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <ul className="flex flex-col gap-3">
            {page.items.map((inv) => (
              <li key={inv.id}>
                <Card>
                  <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-ink">{inv.invoiceNumber} · {inr(inv.totalPaise)}</p>
                        <p className="text-xs text-muted">{t("seller")}: {inv.sellerName} · {t("purchaseOrder")}: {inv.purchaseOrderNumber} · {day(inv.invoiceDate, locale)}</p>
                      </div>
                      <DueBadge inv={inv} locale={locale} />
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      <Link href={`/buyer/orders/${inv.orderId}/purchase-order#invoice-${inv.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("viewOrder")}</Link>
                    </div>
                    {inv.status === "open" ? (
                      <PayDisclosure invoiceId={inv.id} orderId={inv.orderId} balance={inr(inv.outstandingPaise)} today={today} minDate={inv.invoiceDate} locale={locale} />
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {page.nextCursor ? (
          <nav aria-label={t("paginationLabel")} className="flex justify-center">
            <Link href={`/buyer/payables?filter=${filter}&cursor=${page.nextCursor}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink">{t("older")}</Link>
          </nav>
        ) : null}
        <Alert tone="info">{t("disclaimer")}</Alert>
      </div>
    </Container>
  );
}

async function PayDisclosure(p: { invoiceId: string; orderId: string; balance: string; today: string; minDate: string; locale: Awaited<ReturnType<typeof getRequestLocale>> }) {
  const t = await getTranslations({ locale: p.locale, namespace: "po.pay" });
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="min-h-11 cursor-pointer text-sm font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{t("title")}</summary>
      <div className="pt-3"><PayForm invoiceId={p.invoiceId} orderId={p.orderId} balanceLabel={p.balance} today={p.today} minDate={p.minDate} /></div>
    </details>
  );
}
