import type { PurchaseOrderView, SupplierInvoiceView } from "@cnote/enquiry";
import { Badge, Card, CardBody, CardTitle, Money, type BadgeTone } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import Image from "next/image";
import type { Locale } from "@/i18n/config";
import { PayForm } from "./po-forms";

/** A date-only value ("YYYY-MM-DD", Indian calendar) in the reader's language. */
export function day(iso: string, locale: Locale): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(`${locale}-IN-u-nu-latn`, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
const instant = (iso: string, locale: Locale) => new Date(iso).toLocaleString(`${locale}-IN-u-nu-latn`, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export const PO_TONE: Record<PurchaseOrderView["status"], BadgeTone> = { issued: "warning", acknowledged: "success", rejected: "danger", cancelled: "neutral" };

/** "Pay by 31 Oct 2026" plus days left / overdue. Status is text, never colour alone. */
export async function DueBadge({ inv, locale }: { inv: SupplierInvoiceView; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "po.invoices" });
  if (inv.status === "void") return <Badge tone="neutral">{t("statusVoid")}</Badge>;
  if (inv.status === "paid") return <Badge tone={inv.due.paidLate ? "warning" : "success"}>{inv.due.paidLate ? t("paidLate") : t("statusPaid")}</Badge>;
  const left = inv.due.daysRemaining;
  if (left === null || !inv.due.dueDate) return <Badge tone="neutral">{t("statusOpen")}</Badge>;
  const tone: BadgeTone = left < 0 ? "danger" : left <= 7 ? "warning" : "neutral";
  const when = left < 0 ? t("overdueBy", { days: -left }) : left === 0 ? t("dueToday") : t("daysLeft", { days: left });
  return (
    <Badge tone={tone}>
      {t("payBy", { date: day(inv.due.dueDate, locale) })}: {when}
    </Badge>
  );
}

/** One supplier invoice with its e-invoice / e-way bill references, due-date basis and (for the buyer) the payment form. */
export async function InvoiceCard({ inv, locale, orderId, today, canPay }: { inv: SupplierInvoiceView; locale: Locale; orderId: string; today: string; canPay: boolean }) {
  const t = await getTranslations({ locale, namespace: "po.invoices" });
  const e = inv.eInvoice;
  const d = inv.due;
  return (
    <Card id={`invoice-${inv.id}`}>
      <CardBody className="flex flex-col gap-3">
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
            {d.cappedAtStatutory ? `${t("capped", { agreed: d.agreedDays ?? 0 })} ` : ""}
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
                {e.ackDate ? <div><dt className="text-xs text-muted">{t("ackDate")}</dt><dd>{instant(e.ackDate, locale)}</dd></div> : null}
                <p className={e.check === "mismatch" ? "font-medium text-danger" : "text-xs text-muted"}>{t(`check.${e.check}`)}</p>
              </dl>
              {e.qrDataUri ? (
                <Image src={e.qrDataUri} alt={t("qrAlt")} width={132} height={132} unoptimized className="shrink-0 rounded bg-white" />
              ) : null}
            </div>
          </section>
        ) : null}
        {inv.ewayBill ? (
          <section aria-label={t("ewb")} className="rounded-lg border border-line p-3 text-sm">
            <h4 className="font-semibold text-ink">{t("ewb")}</h4>
            <p>{t("ewbNumber")}: <span className="font-mono">{inv.ewayBill.number}</span></p>
            {inv.ewayBill.validUntil ? (
              <p>{t("ewbValid")}: {instant(inv.ewayBill.validUntil, locale)} {inv.ewayBill.expired ? <Badge tone="warning">{t("ewbExpired")}</Badge> : null}</p>
            ) : null}
          </section>
        ) : null}

        {inv.payments.length ? (
          <section aria-label={t("payments")}>
            <h4 className="text-sm font-semibold text-ink">{t("payments")}</h4>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {inv.payments.map((p) => <li key={p.id}>{t("paymentRow", { amount: inr(p.amountPaise), date: day(p.paidOn, locale), reference: p.reference })}</li>)}
            </ul>
          </section>
        ) : null}

        {canPay && inv.status === "open" ? <PayDisclosure inv={inv} orderId={orderId} today={today} locale={locale} /> : null}
      </CardBody>
    </Card>
  );
}

async function PayDisclosure({ inv, orderId, today, locale }: { inv: SupplierInvoiceView; orderId: string; today: string; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "po.pay" });
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="min-h-11 cursor-pointer text-sm font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{t("title")}</summary>
      <div className="pt-3">
        <PayForm invoiceId={inv.id} orderId={orderId} balanceLabel={inr(inv.outstandingPaise)} today={today} minDate={inv.invoiceDate} />
      </div>
    </details>
  );
}

export function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}

export { Money, inr };
