import { getOrder, getPurchaseOrderForOrder, getPurchaseOrderMatch, purchaseOrdersEnabled } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { MatchSettingsForm } from "@/features/grn/forms";
import { InvoiceMatchCard, MatchBadge } from "@/features/grn/views";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grn" });
  return { title: t("match.metaTitle") };
}

export default async function BuyerMatchPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/orders/${id}/match`);
  if (!purchaseOrdersEnabled()) notFound();
  const actor = actorOf(s);
  const order = await getOrder(actor, id);
  if (!order || order.role !== "buyer" || order.settlement === "ondc") notFound();
  const po = await getPurchaseOrderForOrder(actor, id);
  if (!po) notFound();
  const m = await getPurchaseOrderMatch(actor, po.id);
  if (!m) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "grn.match" });
  return (
    <Container className="max-w-3xl py-8">
      <Link href={`/buyer/orders/${id}/receipts`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("back")}</Link>
      <PageHeader title={t("title")} description={t("subtitle", { po: po.number })} actions={m.overall ? <MatchBadge status={m.overall} locale={locale} /> : undefined} />
      <div className="mt-6 flex flex-col gap-6">
        <Alert tone="info">{t("intro")}</Alert>
        {m.receiptCount === 0 ? <Alert tone="warning">{t("noReceipt")} <Link className="font-medium underline" href={`/buyer/orders/${id}/receipts`}>{t("noReceiptLink")}</Link></Alert> : null}
        <Card>
          <CardBody className="flex flex-col gap-3">
            <CardTitle>{t("poLines")}</CardTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <caption className="sr-only">{t("poLinesCaption", { po: po.number })}</caption>
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th scope="col" className="py-1 pr-3 font-medium">{t("item")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("ordered")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("received")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("accepted")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("rejected")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("billed")}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.lines.map((l) => (
                    <tr key={l.lineNo} className="border-t border-line">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">{l.description}</th>
                      <td className="px-2 py-1.5 text-right tabular-nums">{l.orderedQty} {l.unit}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{l.receivedQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{l.acceptedQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{l.rejectedQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{l.billedQty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
        {m.invoices.length === 0 ? <p className="text-sm text-muted">{t("noInvoices")}</p> : m.invoices.map((i) => <InvoiceMatchCard key={i.invoiceId} m={i} locale={locale} role="buyer" />)}
        <Card>
          <CardBody className="flex flex-col gap-3">
            <CardTitle>{t("tolerances")}</CardTitle>
            <p className="text-sm text-muted">{t("tolerancesIntro", { qty: m.tolerances.qtyBps / 100, price: m.tolerances.priceBps / 100 })}</p>
            <MatchSettingsForm orderId={id} qtyPercent={m.tolerances.qtyBps / 100} pricePercent={m.tolerances.priceBps / 100} blockPendingGrn={m.tolerances.blockPendingGrn} />
          </CardBody>
        </Card>
        <p><Link href="/buyer/payables" className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 underline">{t("toPayables")}</Link></p>
      </div>
    </Container>
  );
}
