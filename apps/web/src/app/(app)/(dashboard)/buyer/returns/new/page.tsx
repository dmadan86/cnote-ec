import { getGoodsReceipt, getReturnableLines, purchaseOrdersEnabled } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { ReturnRequestForm } from "@/features/grn/forms";
import { day } from "@/features/purchase-orders/po-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grn" });
  return { title: t("returnForm.metaTitle") };
}

export default async function NewReturnPage(props: { searchParams: Promise<{ receipt?: string }> }) {
  const { receipt } = await props.searchParams;
  const s = await requireBusiness(`/buyer/returns/new?receipt=${receipt ?? ""}`);
  if (!purchaseOrdersEnabled() || !receipt) notFound();
  const actor = actorOf(s);
  const [grn, view] = await Promise.all([getGoodsReceipt(actor, receipt), getReturnableLines(actor, receipt)]);
  if (!grn || !view) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "grn.returnForm" });
  const any = view.lines.some((l) => l.rejectedReturnable + l.acceptedReturnable > 0);
  return (
    <Container className="max-w-3xl py-8">
      <Link href={`/buyer/orders/${grn.orderId}/receipts#receipt-${grn.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("back")}</Link>
      <PageHeader title={t("title")} description={t("subtitle", { number: grn.number })} />
      <div className="mt-6 flex flex-col gap-4">
        <Alert tone="info">{t("intro", { date: day(view.deadline, locale) })}</Alert>
        {!view.windowOpen ? <Alert tone="warning">{t("windowClosed", { date: day(view.deadline, locale) })}</Alert> : !any ? <Alert tone="warning">{t("nothingLeft")}</Alert> : (
          <Card>
            <CardBody>
              <ReturnRequestForm receiptId={grn.id} lines={view.lines.map((l) => ({ receiptLineId: l.receiptLineId, description: l.description, unit: l.unit, rejectedReturnable: l.rejectedReturnable, acceptedReturnable: l.acceptedReturnable }))} />
            </CardBody>
          </Card>
        )}
      </div>
    </Container>
  );
}
