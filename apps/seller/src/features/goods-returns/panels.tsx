import { getLocale, getTranslations } from "next-intl/server";
import { actorOf, type SessionWithBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, type BadgeTone } from "@cnote/ui";
import { isLocale } from "@/i18n/config";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { day, inr } from "@/features/purchase-orders/views";

const TONE: Record<string, BadgeTone> = { matched: "success", within_tolerance: "brand", mismatch: "danger", pending_grn: "warning" };

/** Seller view on a purchase order: what the buyer received (accepted / rejected) and how each invoice matches. Both sides see the same match. */
export async function ReceiptsAndMatch({ orderId, purchaseOrderId, session }: { orderId: string; purchaseOrderId: string; session: SessionWithBusiness }) {
  const t = await getTranslations("goodsReturns.panel");
  const tr = await getTranslations("goodsReturns.reasons");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const actor = actorOf(session);
  const [rec, match] = await Promise.all([load(() => enquiry.listGoodsReceiptsForOrder(actor, orderId)), load(() => enquiry.getPurchaseOrderMatch(actor, purchaseOrderId))]);
  if (!rec.ok) return <Alert tone="danger">{rec.error}</Alert>;
  const receipts = rec.data;
  const m = match.ok ? match.data : null;
  return (
    <section aria-labelledby="po-receipts" className="space-y-3">
      <h2 id="po-receipts" className="text-lg font-semibold text-ink">{t("title")}</h2>
      {receipts.length === 0 ? <p className="text-sm text-muted">{t("none")}</p> : (
        <ul className="space-y-3">
          {receipts.map((r) => (
            <li key={r.id}>
              <Card>
                <CardHeader><CardTitle className="font-mono text-base">{r.number}</CardTitle></CardHeader>
                <CardBody className="space-y-2">
                  <p className="text-xs text-muted">{t("meta", { date: day(r.receivedOn, locale), receiver: r.receiverName })}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[26rem] text-sm">
                      <caption className="sr-only">{t("tableCaption", { number: r.number })}</caption>
                      <thead>
                        <tr className="border-b border-line text-xs text-muted">
                          <th scope="col" className="py-2 pe-2 text-start font-medium">{t("item")}</th>
                          <th scope="col" className="py-2 pe-2 text-end font-medium">{t("received")}</th>
                          <th scope="col" className="py-2 pe-2 text-end font-medium">{t("accepted")}</th>
                          <th scope="col" className="py-2 text-end font-medium">{t("rejected")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.lines.map((l) => (
                          <tr key={l.id} className="border-b border-line align-top">
                            <th scope="row" className="py-2 pe-2 text-start font-normal">{l.description}{l.rejectReason ? <span className="block text-xs text-muted">{tr(l.rejectReason)}{l.rejectNote ? `: ${l.rejectNote}` : ""}</span> : null}</th>
                            <td className="py-2 pe-2 text-end tabular-nums">{l.receivedQty} {l.unit}</td>
                            <td className="py-2 pe-2 text-end tabular-nums">{l.acceptedQty}</td>
                            <td className="py-2 text-end tabular-nums">{l.rejectedQty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {r.photos.length ? (
                    <ul className="flex flex-wrap gap-x-4 text-sm" aria-label={t("photos")}>
                      {r.photos.map((p) => <li key={p.id}><a className="inline-flex min-h-11 items-center font-medium text-brand-700 underline" href={`/api/goods-receipts/photos/${p.id}`} target="_blank" rel="noopener noreferrer">{p.fileName}</a></li>)}
                    </ul>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {m && m.invoices.length ? (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("matchTitle")}</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-muted">{t("matchIntro", { qty: m.tolerances.qtyBps / 100, price: m.tolerances.priceBps / 100 })}</p>
            <ul className="space-y-3">
              {m.invoices.map((i) => (
                <li key={i.invoiceId} className="space-y-1 rounded-lg border border-line p-3">
                  <p className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
                    <span>{t("invoice", { number: i.invoiceNumber })}</span>
                    <Badge tone={TONE[i.status]}>{t(`status.${i.status}`)}</Badge>
                  </p>
                  {i.basis === "line" ? (
                    <ul className="text-sm">
                      {i.lines.map((l) => (
                        <li key={l.poLineNo} className="flex flex-wrap justify-between gap-2">
                          <span>{l.description || t("unknownLine", { n: l.poLineNo })}: {t("lineFacts", { billed: l.billedQty, accepted: l.acceptedQty, price: inr(l.invoiceUnitPricePaise), poPrice: inr(l.poUnitPricePaise) })}</span>
                          <span className="text-xs text-muted">{t(`status.${l.status}`)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-sm">{t("amountFacts", { billed: inr(i.amount.billedPaise), accepted: inr(i.amount.acceptedPaise) })}</p>}
                  {i.status === "mismatch" ? <p className="text-sm text-muted">{t("mismatchHint")}</p> : null}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </section>
  );
}
