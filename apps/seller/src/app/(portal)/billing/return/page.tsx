import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { billing } from "@/lib/services";
import { AutoRefresh } from "@/features/billing/checkout-forms";
import { el } from "@/features/billing/rich-value";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("billing.return"))("metaTitle") };
}
export const dynamic = "force-dynamic";

export default async function BillingReturnPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSeller("/billing");
  const t = await getTranslations("billing.return");
  const sp = await searchParams;
  const order = typeof sp.order === "string" ? sp.order : "";
  const res = /^[0-9a-f-]{36}$/i.test(order) ? await load(() => billing.getPaymentStatus({ businessId: session.business.id }, order, { sync: true })) : null;
  const o = res?.ok ? res.data : null;
  const pending = !o || o.status === "created" || o.status === "pending";

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} />
      <AutoRefresh active={!!o && pending} />
      {!o ? <Alert tone="danger">{t("notFound")}</Alert> : (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-muted">{t("order", { id: o.id.slice(0, 8) })}</p>
            <p className="text-lg font-semibold text-ink">{t.rich("total", { amount: el(<Money paise={o.totalPaise} />) })}</p>
            {o.status === "paid" || o.status === "refunded" || o.status === "partially_refunded" ? (
              <Alert tone="success">{t("received")}</Alert>
            ) : o.status === "failed" ? (
              <Alert tone="danger">{o.failureReason === "amount_mismatch" ? t("failedMismatch") : t("failed")}</Alert>
            ) : (
              <Alert tone="info">{t("waiting")}</Alert>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              {o.invoiceId ? <a href={`/api/invoices/${o.invoiceId}`} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white" download>{t("downloadInvoice")}</a> : null}
              <Link href="/billing" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-ink">{t("back")}</Link>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
