import { addDays, getOrder, getPurchaseOrderForOrder, getReceivingStatus, getReturnableLines, istDate, listGoodsReceiptsForOrder, listReturnsForOrder, purchaseOrdersEnabled } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { ReceiptForm } from "@/features/grn/forms";
import { ReceiptCard, ReturnRow } from "@/features/grn/views";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grn" });
  return { title: t("receipts.metaTitle") };
}

export default async function BuyerReceiptsPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/orders/${id}/receipts`);
  if (!purchaseOrdersEnabled()) notFound();
  const actor = actorOf(s);
  const order = await getOrder(actor, id);
  if (!order || order.role !== "buyer" || order.settlement === "ondc") notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "grn.receipts" });
  const now = new Date();
  const today = istDate(now);
  const po = await getPurchaseOrderForOrder(actor, id, now);
  const back = <Link href={`/buyer/orders/${id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("back")}</Link>;
  if (!po) {
    return (
      <Container className="max-w-3xl py-8">
        {back}
        <PageHeader title={t("title")} description={order.enquiryTitle} />
        <div className="mt-6"><Alert tone="info">{t("needPo")} <Link className="font-medium underline" href={`/buyer/orders/${id}/purchase-order`}>{t("needPoLink")}</Link></Alert></div>
      </Container>
    );
  }
  const [status, receipts, returns] = await Promise.all([getReceivingStatus(actor, po.id), listGoodsReceiptsForOrder(actor, id, now), listReturnsForOrder(actor, id)]);
  // which receipts still have something returnable
  const returnable = new Map<string, boolean>();
  for (const r of receipts) {
    const v = await getReturnableLines(actor, r.id, now);
    returnable.set(r.id, !!v && v.lines.some((l) => l.rejectedReturnable + l.acceptedReturnable > 0));
  }
  return (
    <Container className="max-w-3xl py-8">
      {back}
      <PageHeader title={t("title")} description={t("subtitle", { po: po.number })} />
      <div className="mt-6 flex flex-col gap-6">
        <Alert tone="info">{t("intro")}</Alert>
        {status ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <CardTitle>{t("progress")}</CardTitle>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <caption className="sr-only">{t("progressCaption", { po: po.number })}</caption>
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th scope="col" className="py-1 pr-3 font-medium">{t("item")}</th>
                      <th scope="col" className="px-2 py-1 text-right font-medium">{t("ordered")}</th>
                      <th scope="col" className="px-2 py-1 text-right font-medium">{t("received")}</th>
                      <th scope="col" className="px-2 py-1 text-right font-medium">{t("accepted")}</th>
                      <th scope="col" className="px-2 py-1 text-right font-medium">{t("rejected")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.lines.map((l) => (
                      <tr key={l.lineNo} className="border-t border-line">
                        <th scope="row" className="py-1.5 pr-3 text-left font-normal">{l.description}</th>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.orderedQty} {l.unit}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.receivedQty}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.acceptedQty}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.rejectedQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Link href={`/buyer/orders/${id}/match`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 underline">{t("viewMatch")}</Link>
            </CardBody>
          </Card>
        ) : null}

        <section aria-labelledby="new-grn" className="flex flex-col gap-3">
          <h2 id="new-grn" className="text-lg font-semibold text-ink">{t("record")}</h2>
          {status?.canReceive ? (
            <Card>
              <CardBody>
                <ReceiptForm
                  orderId={id} purchaseOrderId={po.id} today={today} minDate={addDays(today, -60)}
                  lines={status.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, unit: l.unit, orderedQty: l.orderedQty, receivedQty: l.receivedQty, maxReceivable: l.maxReceivable }))}
                />
              </CardBody>
            </Card>
          ) : <Alert tone="warning">{status?.blockedReason ?? t("cannotReceive")}</Alert>}
        </section>

        <section aria-labelledby="grn-list" className="flex flex-col gap-3">
          <h2 id="grn-list" className="text-lg font-semibold text-ink">{t("recorded")}</h2>
          {receipts.length === 0 ? <p className="text-sm text-muted">{t("none")}</p> : receipts.map((r) => <ReceiptCard key={r.id} r={r} locale={locale} returnable={returnable.get(r.id) ?? false} />)}
        </section>

        {returns.length ? (
          <section aria-labelledby="ret-list" className="flex flex-col gap-3">
            <h2 id="ret-list" className="text-lg font-semibold text-ink">{t("returns")}</h2>
            {returns.map((r) => <ReturnRow key={r.id} r={r} locale={locale} href={`/buyer/returns/${r.id}`} />)}
          </section>
        ) : null}
      </div>
    </Container>
  );
}
