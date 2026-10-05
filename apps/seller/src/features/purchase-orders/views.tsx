import { getTranslations } from "next-intl/server";
import type { PurchaseOrderView, SupplierInvoiceView } from "@cnote/enquiry";
import { Badge, Card, CardBody, CardTitle, type BadgeTone } from "@cnote/ui";
import { bcp47, type Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { VoidInvoiceForm } from "./forms";

/** A date-only value ("YYYY-MM-DD", Indian calendar) in the seller's language, Latin digits. */
export function day(iso: string, locale: Locale): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(bcp47(locale), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC", numberingSystem: "latn" });
}
export const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export const PO_TONE: Record<PurchaseOrderView["status"], BadgeTone> = { issued: "warning", acknowledged: "success", rejected: "danger", cancelled: "neutral" };

export function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}

async function DueBadge({ inv, locale }: { inv: SupplierInvoiceView; locale: Locale }) {
  const t = await getTranslations("purchaseOrders.invoices");
  if (inv.status === "void") return <Badge tone="neutral">{t("statusVoid")}</Badge>;
  if (inv.status === "paid") return <Badge tone={inv.due.paidLate ? "warning" : "success"}>{inv.due.paidLate ? t("paidLate") : t("statusPaid")}</Badge>;
  const left = inv.due.daysRemaining;
  if (left === null || !inv.due.dueDate) return <Badge tone="neutral">{t("statusOpen")}</Badge>;
  const when = left < 0 ? t("overdueBy", { days: -left }) : left === 0 ? t("dueToday") : t("daysLeft", { days: left });
  return <Badge tone={left < 0 ? "danger" : left <= 7 ? "warning" : "neutral"}>{t("dueBy", { date: day(inv.due.dueDate, locale) })}: {when}</Badge>;
}

export async function InvoiceCard({ inv, locale, orderId }: { inv: SupplierInvoiceView; locale: Locale; orderId: string }) {
  const t = await getTranslations("purchaseOrders.invoices");
  const e = inv.eInvoice;
  const d = inv.due;
  return (
    <Card id={`invoice-${inv.id}`}>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{t("number", { number: inv.invoiceNumber })}</CardTitle>
            <p className="text-xs text-muted">{t("dated", { date: day(inv.invoiceDate, locale) })}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {d.msmeCovered && inv.status !== "void" ? <Badge tone="brand">{t("msmeBadge")}</Badge> : null}
            <DueBadge inv={inv} locale={locale} />
          </div>
        </div>
        <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>{t("taxable", { amount: inr(inv.taxablePaise) })}</span>
          <span>{t("gst", { amount: inr(inv.gstPaise) })}</span>
          <span className="font-semibold">{t("total", { amount: inr(inv.totalPaise) })}</span>
        </p>
        {inv.status === "void" ? <p className="text-sm text-muted">{t("withdrawn", { reason: inv.voidReason ?? "" })}</p> : null}
        {inv.status === "open" && inv.paidPaise > 0 ? <p className="text-sm">{t("partPaid", { paid: inr(inv.paidPaise), total: inr(inv.totalPaise) })}</p> : null}
        {d.msmeCovered && inv.status !== "void" ? (
          <p className="text-xs text-muted">
            {d.agreementBasis === "written_agreement" ? t("agreementWritten", { days: d.statutoryDays ?? 0 }) : t("agreementNone")}{" "}
            {d.dueBasis === "delivery" ? t("dueFromDelivery", { date: day(d.acceptanceDate, locale) }) : t("dueFromInvoice", { date: day(d.acceptanceDate, locale) })}
          </p>
        ) : null}
        {inv.file ? <a className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline" href={`/api/supplier-invoices/${inv.id}/file`}>{t("file")} ({inv.file.fileName})</a> : null}
        {e ? (
          <section aria-label={t("eInvoice")} className="rounded-lg border border-line p-3">
            <h4 className="text-sm font-semibold text-ink">{t("eInvoice")}</h4>
            <div className="mt-2 flex flex-wrap gap-4">
              <dl className="min-w-0 flex-1 space-y-1 text-sm">
                <div><dt className="text-xs text-muted">{t("irn")}</dt><dd className="break-all font-mono text-xs">{e.irn}</dd></div>
                {e.ackNo ? <div><dt className="text-xs text-muted">{t("ackNo")}</dt><dd className="font-mono text-xs">{e.ackNo}</dd></div> : null}
                {e.ackDate ? <div><dt className="text-xs text-muted">{t("ackDate")}</dt><dd>{formatDateTime(e.ackDate, locale)}</dd></div> : null}
              </dl>
              {e.qrDataUri ? (
                // eslint-disable-next-line @next/next/no-img-element -- a generated SVG data URI; next/image adds nothing here
                <img src={e.qrDataUri} alt={t("qrAlt")} width={132} height={132} className="shrink-0 rounded bg-white" />
              ) : null}
            </div>
            <p className={e.check === "mismatch" ? "mt-2 text-sm font-medium text-danger" : "mt-2 text-xs text-muted"}>{t(`check.${e.check}`)}</p>
          </section>
        ) : null}
        {inv.ewayBill ? (
          <section aria-label={t("ewb")} className="rounded-lg border border-line p-3 text-sm">
            <h4 className="font-semibold text-ink">{t("ewb")}</h4>
            <p>{t("ewbNumber")}: <span className="font-mono">{inv.ewayBill.number}</span></p>
            {inv.ewayBill.validUntil ? <p>{t("ewbValid")}: {formatDateTime(inv.ewayBill.validUntil, locale)} {inv.ewayBill.expired ? <Badge tone="warning">{t("ewbExpired")}</Badge> : null}</p> : null}
          </section>
        ) : null}
        {inv.payments.length ? (
          <section aria-label={t("payments")}>
            <h4 className="text-sm font-semibold text-ink">{t("payments")}</h4>
            <ul className="mt-1 list-disc ps-5 text-sm">
              {inv.payments.map((p) => <li key={p.id}>{t("paymentRow", { amount: inr(p.amountPaise), date: day(p.paidOn, locale), reference: p.reference })}</li>)}
            </ul>
          </section>
        ) : null}
        {inv.status === "open" && inv.paidPaise === 0 ? (
          <details className="rounded-lg border border-line p-3">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand-700">{t("void")}</summary>
            <div className="pt-3"><VoidInvoiceForm orderId={orderId} invoiceId={inv.id} /></div>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}
