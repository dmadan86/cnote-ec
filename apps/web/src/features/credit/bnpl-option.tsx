import { getBnplOption, TENORS, type Kfs } from "@cnote/credit";
import { Alert, Card, CardBody, CardTitle, Money } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import { type Locale } from "@/i18n/config";
import { BnplAcceptForm, BnplApplyForm, BnplExitForm, BnplSimulateForm } from "./bnpl-forms";

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/**
 * Buy-now-pay-later at escrow funding (ADR-019). Renders nothing unless CREDIT_ENABLED and the buyer's escrow is still unfunded
 * (or a BNPL application already exists). The partner is the lender of record and is named in every state. WCAG 2.2 AA:
 * a labelled section, a real checkbox for consent and for KFS acknowledgement, a definition list for the KFS, polite errors.
 */
export async function BnplOption({ actor, orderId, escrowId, locale = "en" }: { actor: { personId: string; businessId: string }; orderId: string; escrowId: string; locale?: Locale }) {
  const opt = await getBnplOption(actor, escrowId).catch(() => null);
  if (!opt || !opt.enabled || !opt.available) return null;
  const t = await getTranslations({ locale, namespace: "credit" });
  const dt = new Intl.DateTimeFormat(`${locale}-IN`, { dateStyle: "medium", timeZone: "Asia/Kolkata" });
  const lender = opt.lender.name;
  const labels = {
    consent: t("consentLabel", { lender }), tenor: t("tenorLabel"), tenorOptions: TENORS.bnpl.map((d) => ({ value: d, label: t("days", { days: d }) })),
    apply: t("apply"), noAuto: t("noAuto"), error: t("error"), acknowledge: t("accept.acknowledge", { lender }), accept: t("accept.submit"), decline: t("accept.decline"), simulate: t("dev.simulate"),
    exitConfirm: t("exit.confirm", { lender }), exitSubmit: t("exit.submit"),
  };
  const app = opt.application;
  const offer = app?.status === "offered" ? app.offers.find((o) => o.status === "open") : undefined;
  return (
    <section aria-labelledby="bnpl-heading">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <CardTitle id="bnpl-heading" className="text-lg">{t("heading")}</CardTitle>
          <p className="text-sm text-ink">{t("intro", { lender })}</p>
          {!app || !["submitted", "offered", "accepted", "disbursed"].includes(app.status) ? (
            <>
              {app?.loan?.status === "cancelled" && app.loan.cancelReason === "cooling_off" ? (
                <Alert tone="info">{t("exit.done")} {app.loan.exitAmountPaise !== null ? <Money paise={app.loan.exitAmountPaise} /> : null}</Alert>
              ) : app ? <Alert tone="info">{t(`status.${app.status}`)}</Alert> : null}
              <BnplApplyForm orderId={orderId} escrowId={escrowId} needsConsent={!opt.consented} labels={labels} />
            </>
          ) : offer ? (
            <>
              <Kfs kfs={offer.kfs} expiresAt={offer.expiresAt} t={t} date={(iso) => dt.format(new Date(iso))} />
              <BnplAcceptForm orderId={orderId} offerId={offer.id} kfsVersion={offer.kfs.version} labels={labels} />
            </>
          ) : (
            <>
              <p className="text-sm text-ink" role="status">{t(`status.${app.status}`)}</p>
              {opt.exitQuote && app.loan ? (
                <section aria-labelledby="bnpl-exit-heading" className="rounded-card border border-line p-4">
                  <h3 id="bnpl-exit-heading" className="text-sm font-semibold text-ink">{t("exit.heading")}</h3>
                  <p className="mt-1 text-sm text-muted">{t("exit.intro", { date: dt.format(new Date(opt.exitQuote.windowEndsAt)) })}</p>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <div><dt className="text-muted">{t("exit.principal")}</dt><dd className="font-medium"><Money paise={opt.exitQuote.principalPaise} /></dd></div>
                    <div><dt className="text-muted">{t("exit.interest", { days: opt.exitQuote.interestDays })}</dt><dd className="font-medium"><Money paise={opt.exitQuote.interestPaise} /></dd></div>
                    <div><dt className="text-muted">{opt.exitQuote.feesWaived ? t("exit.feesWaived") : t("exit.fees")}</dt><dd className="font-medium"><Money paise={opt.exitQuote.feesPaise} /></dd></div>
                    <div><dt className="text-muted">{t("exit.total")}</dt><dd className="font-semibold text-ink"><Money paise={opt.exitQuote.payablePaise} /></dd></div>
                  </dl>
                  <p className="mt-3 text-sm text-muted">{t("exit.note_bnpl")}</p>
                  <div className="mt-3"><BnplExitForm orderId={orderId} loanId={app.loan.id} payablePaise={opt.exitQuote.payablePaise} labels={labels} /></div>
                </section>
              ) : null}
              {app.status === "accepted" && app.partner === "mock" && process.env.NODE_ENV !== "production" ? <BnplSimulateForm orderId={orderId} applicationId={app.id} label={labels.simulate} error={labels.error} /> : null}
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

type T = Awaited<ReturnType<typeof getTranslations>>;

function Kfs({ kfs, expiresAt, t, date }: { kfs: Kfs; expiresAt: string; t: T; date: (iso: string) => string }) {
  const rows: [string, React.ReactNode][] = [
    [t("kfs.lender"), kfs.lenderName],
    [t("kfs.principal"), <Money key="p" paise={kfs.principalPaise} />],
    [t("kfs.tenor"), t("days", { days: kfs.tenorDays })],
    [t("kfs.interestRate"), pct(kfs.aprBps)],
    [t("kfs.allInApr"), pct(kfs.allInAprBps)],
    [t("kfs.interest"), <Money key="i" paise={kfs.interestPaise} />],
    [t("kfs.processingFee"), <Money key="f" paise={kfs.processingFeePaise} />],
    [t("kfs.otherFees"), <Money key="o" paise={kfs.otherFeesPaise} />],
    [t("kfs.total"), <strong key="t"><Money paise={kfs.totalRepayablePaise} /></strong>],
    [t("kfs.lateFee"), t("kfs.lateFeeValue", { percent: pct(kfs.lateFeeBpsPerMonth) })],
    [t("kfs.coolingOff"), t("kfs.coolingOffValue", { days: kfs.coolingOffDays })],
    [t("kfs.prepayment"), kfs.prepaymentCharge === "none" ? t("kfs.prepaymentNone") : kfs.prepaymentCharge],
    [t("kfs.repayment"), t("kfs.repayment_buyer_instalment")],
    [t("kfs.grievance"), t("kfs.grievanceValue", { name: kfs.grievanceOfficer.name, email: kfs.grievanceOfficer.email, phone: kfs.grievanceOfficer.phone })],
  ];
  return (
    <section aria-label={t("kfs.heading")} className="rounded-card border border-line p-4">
      <h3 className="text-sm font-semibold text-ink">{t("kfs.heading")}</h3>
      <p className="mt-1 text-sm text-muted">{t("kfs.intro", { lender: kfs.lenderName })}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => <div key={k}><dt className="text-muted">{k}</dt><dd className="font-medium text-ink">{v}</dd></div>)}
      </dl>
      <p className="mt-3 text-sm text-muted">{t("kfs.expires", { date: date(expiresAt) })}</p>
    </section>
  );
}
