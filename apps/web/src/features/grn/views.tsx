import type { GoodsReceiptView, GoodsReturnView, InvoiceMatchView, MatchStatus, ReturnStatus } from "@cnote/enquiry";
import { Badge, Card, CardBody, CardTitle, type BadgeTone } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { day, inr } from "@/features/purchase-orders/po-view";

export const MATCH_TONE: Record<MatchStatus, BadgeTone> = { matched: "success", within_tolerance: "brand", mismatch: "danger", pending_grn: "warning" };
export const RETURN_TONE: Record<ReturnStatus, BadgeTone> = { requested: "warning", approved: "brand", rejected: "danger", cancelled: "neutral", shipped: "brand", received: "brand", credited: "success" };

/** Status is always text; the tone is only reinforcement. */
export async function MatchBadge({ status, locale }: { status: MatchStatus; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "grn.match.status" });
  return <Badge tone={MATCH_TONE[status]}>{t(status)}</Badge>;
}

export async function ReturnBadge({ status, locale }: { status: ReturnStatus; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "grn.returnStatus" });
  return <Badge tone={RETURN_TONE[status]}>{t(status)}</Badge>;
}

/** One goods receipt: header facts, a line table (received / accepted / rejected + reason), photos and the return entry point. */
export async function ReceiptCard({ r, locale, returnable }: { r: GoodsReceiptView; locale: Locale; returnable: boolean }) {
  const t = await getTranslations({ locale, namespace: "grn.receipt" });
  const tr = await getTranslations({ locale, namespace: "grn.reasons" });
  return (
    <Card id={`receipt-${r.id}`}>
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="font-mono text-base">{r.number}</CardTitle>
            <p className="text-xs text-muted">{t("meta", { date: day(r.receivedOn, locale), receiver: r.receiverName })}{r.deliveryNoteRef ? ` · ${t("challan", { ref: r.deliveryNoteRef })}` : ""}</p>
          </div>
          {r.confirmedDelivery ? <Badge tone="success">{t("confirmedDelivery")}</Badge> : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <caption className="sr-only">{t("tableCaption", { number: r.number })}</caption>
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-1 pr-3 font-medium">{t("item")}</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">{t("received")}</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">{t("accepted")}</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">{t("rejected")}</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id} className="border-t border-line align-top">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    {l.description}
                    {l.rejectReason ? <span className="block text-xs text-muted">{tr(l.rejectReason)}{l.rejectNote ? `: ${l.rejectNote}` : ""}</span> : null}
                  </th>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l.receivedQty} {l.unit}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l.acceptedQty}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l.rejectedQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.note ? <p className="text-sm text-muted">{r.note}</p> : null}
        {r.photos.length ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t("photos")}>
            {r.photos.map((p) => (
              <li key={p.id}><a className="inline-flex min-h-11 items-center font-medium text-brand-700 underline" href={`/api/goods-receipts/photos/${p.id}`} target="_blank" rel="noopener noreferrer">{p.fileName}</a></li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {returnable && r.returnWindow.open ? (
            <Link href={`/buyer/returns/new?receipt=${r.id}`} className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">{t("requestReturn")}</Link>
          ) : null}
          <span className="text-xs text-muted">{r.returnWindow.open ? t("windowOpen", { date: day(r.returnWindow.deadline, locale), days: r.returnWindow.daysLeft }) : t("windowClosed", { date: day(r.returnWindow.deadline, locale) })}</span>
        </div>
      </CardBody>
    </Card>
  );
}

/** Per-invoice three-way match: the per-line (or amount) comparison and what it means for "mark paid". */
export async function InvoiceMatchCard({ m, locale, role }: { m: InvoiceMatchView; locale: Locale; role: "buyer" | "seller" }) {
  const t = await getTranslations({ locale, namespace: "grn.match" });
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{t("invoice", { number: m.invoiceNumber })}</CardTitle>
          <MatchBadge status={m.status} locale={locale} />
        </div>
        {m.basis === "line" ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">{t("tableCaption", { number: m.invoiceNumber })}</caption>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="py-1 pr-3 font-medium">{t("item")}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t("accepted")}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t("billed")}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t("poPrice")}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t("invoicePrice")}</th>
                  <th scope="col" className="px-2 py-1 font-medium">{t("result")}</th>
                </tr>
              </thead>
              <tbody>
                {m.lines.map((l) => (
                  <tr key={l.poLineNo} className="border-t border-line align-top">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">{l.description || t("unknownLine", { n: l.poLineNo })}</th>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.acceptedQty}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.billedQty}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(l.poUnitPricePaise)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(l.invoiceUnitPricePaise)}</td>
                    <td className="px-2 py-1.5">
                      <MatchBadge status={l.status} locale={locale} />
                      {l.status !== "matched" && l.status !== "pending_grn" ? (
                        <span className="mt-1 block text-xs text-muted">
                          {[l.qtyStatus !== "matched" ? t("qtyIssue") : "", l.priceStatus !== "matched" ? t("priceIssue") : ""].filter(Boolean).join(", ")}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm">{t("amountBasis", { billed: inr(m.amount.billedPaise), accepted: inr(m.amount.acceptedPaise) })}</p>
        )}
        {role === "buyer" && m.gate?.blocked ? <p className="text-sm font-medium text-danger">{m.gate.reason === "mismatch" ? t("blockedMismatch") : t("blockedPending")}</p> : null}
        {role === "seller" && m.status === "mismatch" ? <p className="text-sm text-muted">{t("sellerMismatch")}</p> : null}
        {m.overrides.length ? (
          <section aria-label={t("overrides")}>
            <h4 className="text-sm font-semibold text-ink">{t("overrides")}</h4>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {m.overrides.map((o, i) => <li key={i}>{t("overrideRow", { date: day(o.at.slice(0, 10), locale), reason: o.reason })}</li>)}
            </ul>
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** Return summary card for lists. */
export async function ReturnRow({ r, locale, href }: { r: GoodsReturnView; locale: Locale; href: string }) {
  const t = await getTranslations({ locale, namespace: "grn.returns" });
  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink"><Link href={href} className="font-mono underline">{r.number}</Link></p>
          <p className="text-xs text-muted">{t("meta", { units: r.units, amount: inr(r.estimatedPaise), date: day(r.createdAt.slice(0, 10), locale) })}</p>
        </div>
        <ReturnBadge status={r.status} locale={locale} />
      </CardBody>
    </Card>
  );
}
