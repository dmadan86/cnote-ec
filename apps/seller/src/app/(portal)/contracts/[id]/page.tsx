import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { Row, day, inr } from "@/features/purchase-orders/views";
import { ProposeForm, RespondForm, TerminateForm } from "@/features/contracts/forms";
import { RC_TONE, TermsTable, Usage } from "@/features/contracts/views";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("contracts"))("metaTitle") };
}

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  if (!enquiry.rateContractsEnabled()) notFound();
  const { id } = await params;
  const session = await requireSeller(`/contracts/${id}`);
  const t = await getTranslations("contracts");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const back = (
    <Link href="/contracts" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700">
      <ArrowLeft className="size-4" aria-hidden /> {t("back")}
    </Link>
  );
  const res = await load(() => enquiry.getRateContract(actorOf(session), id));
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const c = res.data;
  if (!c || c.role !== "seller") notFound();
  const today = enquiry.istDate(new Date());
  const cur = c.current;
  const pend = c.pending;
  const base = pend ?? cur;
  const pendDeclined = pend && (pend.answers.buyer === "rejected" || pend.answers.seller === "rejected");
  return (
    <div className="space-y-6">
      {back}
      <PageHeader
        title={t("detailTitle", { number: c.number })}
        description={c.title}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={RC_TONE[c.status]}>{t(`status.${c.status}`)}</Badge>
            {c.phase === "not_started" ? <Badge tone="neutral">{t("phase.not_started")}</Badge> : null}
            {c.daysLeft !== null && c.phase === "in_force" ? <Badge tone={c.daysLeft <= 7 ? "warning" : "neutral"}>{t("daysLeft", { days: c.daysLeft })}</Badge> : null}
          </div>
        }
      />
      {c.status === "terminated" ? <Alert tone="info">{t("terminatedBy", { who: t(`party.${c.terminatedByRole ?? "buyer"}`), reason: c.terminationReason ?? "" })}</Alert> : null}
      {c.status === "expired" ? <Alert tone="info">{t("expiredNote")}</Alert> : null}
      {c.status === "active" ? <Alert tone="info">{t("noAutoRenew")}</Alert> : null}

      {pend ? (
        <Card id="pending">
          <CardHeader>
            <CardTitle>
              {c.activeRevision === null ? t("pending.titleFirst", { n: pend.revision }) : t("pending.titleAmend", { n: pend.revision })}{" "}
              <Badge tone={pendDeclined ? "danger" : "warning"}>{pendDeclined ? t("pending.declined") : t("pending.waiting")}</Badge>
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-sm text-muted">{t("pending.by", { who: t(`party.${pend.proposedByRole}`), date: day(pend.createdAt.slice(0, 10), locale) })}</p>
            {pend.changeNote ? <p className="text-sm">{t("pending.changeNote", { note: pend.changeNote })}</p> : null}
            {pend.answers.buyerReason || pend.answers.sellerReason ? <Alert tone="warning">{t("pending.reason", { reason: pend.answers.buyerReason ?? pend.answers.sellerReason ?? "" })}</Alert> : null}
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Row k={t("validityLabel")} v={t("validity", { from: day(pend.validFrom, locale), to: day(pend.validTo, locale) })} />
              <Row k={t("paymentTerms")} v={t("paymentTermsValue", { days: pend.paymentTermsDays })} />
              <Row k={t("priceBasis")} v={t(`basis.${pend.priceBasis}`)} />
              <Row k={t("valueCap")} v={pend.valueCapPaise === null ? t("noCap") : inr(pend.valueCapPaise)} />
              {pend.notes ? <Row k={t("notes")} v={pend.notes} /> : null}
            </dl>
            <TermsTable rev={pend} inr={inr} />
            {c.actions.respond ? <RespondForm contractId={c.id} revision={pend.revision} /> : <p className="text-sm text-muted">{t("pending.waitingOther")}</p>}
          </CardBody>
        </Card>
      ) : null}

      {cur ? (
        <Card>
          <CardHeader><CardTitle>{t("current.title", { n: cur.revision })}</CardTitle></CardHeader>
          <CardBody className="space-y-4">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Row k={t("buyer")} v={c.counterparty.name} />
              <Row k={t("validityLabel")} v={t("validity", { from: day(cur.validFrom, locale), to: day(cur.validTo, locale) })} />
              <Row k={t("paymentTerms")} v={t("paymentTermsValue", { days: cur.paymentTermsDays })} />
              <Row k={t("priceBasis")} v={t(`basis.${cur.priceBasis}`)} />
              <Row k={t("valueCap")} v={cur.valueCapPaise === null ? t("noCap") : inr(cur.valueCapPaise)} />
              {cur.notes ? <Row k={t("notes")} v={cur.notes} /> : null}
            </dl>
            <TermsTable rev={cur} inr={inr} />
            <section aria-labelledby="rc-value" className="space-y-1">
              <h3 id="rc-value" className="text-sm font-semibold text-ink">{t("consumption.title")}</h3>
              <p className="text-sm">{t("consumption.value", { used: inr(c.consumption.valueUsedPaise) })}{c.consumption.valueCapPaise !== null ? ` ${t("consumption.ofCap", { cap: inr(c.consumption.valueCapPaise) })}` : ""}</p>
              {c.consumption.valuePercent !== null ? <Usage percent={c.consumption.valuePercent} label={t("consumption.valueLabel")} /> : null}
              <p className="text-xs text-muted">{t("consumption.beforeTax")}</p>
            </section>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t("callOffs.title")}</CardTitle></CardHeader>
        <CardBody>
          {c.callOffs.length === 0 ? <p className="text-sm text-muted">{t("callOffs.none")}</p> : (
            <ul className="space-y-2 text-sm">
              {c.callOffs.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {t("callOffs.row", { n: o.callOffNo, amount: inr(o.taxablePaise), date: day(o.createdAt.slice(0, 10), locale) })}{" "}
                    {o.status === "cancelled" ? <Badge tone="neutral">{t("callOffs.cancelled")}</Badge> : null}
                  </span>
                  <Link href={`/orders/${o.orderId}`} className="inline-flex min-h-11 items-center font-medium text-brand-700 underline">{t("callOffs.open")}</Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("history.title")}</CardTitle></CardHeader>
        <CardBody>
          <ol className="space-y-2 text-sm">
            {c.history.map((h) => (
              <li key={h.revision}>
                {t("history.row", { n: h.revision, who: t(`party.${h.proposedByRole}`), date: day(h.createdAt.slice(0, 10), locale) })}{" "}
                <Badge tone={h.state === "active" ? "success" : h.state === "declined" ? "danger" : h.state === "pending" ? "warning" : "neutral"}>{t(`history.state.${h.state}`)}</Badge>
                {h.changeNote ? <span className="block text-xs text-muted">{h.changeNote}</span> : null}
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      {c.actions.propose && base ? (
        <Card>
          <CardHeader><CardTitle>{t("propose.title")}</CardTitle></CardHeader>
          <CardBody>
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand-700">{t("propose.open")}</summary>
              <div className="pt-3"><ProposeForm contractId={c.id} base={base} today={today} /></div>
            </details>
          </CardBody>
        </Card>
      ) : null}

      {c.actions.terminate ? (
        <Card>
          <CardBody>
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-danger">{t("terminate.open")}</summary>
              <div className="pt-3"><TerminateForm contractId={c.id} /></div>
            </details>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
