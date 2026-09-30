import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { getCreditOverview, TENORS, type ApplicationView, type CoolingOffQuote, type LoanView, type ScoreView } from "@cnote/credit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, Money, PageHeader, type BadgeTone } from "@cnote/ui";
import { ApplyForm, AcceptForm, ConsentForm, ExitLoanForm, SimulateForm } from "@/features/credit/forms";
import { KfsCard } from "@/features/credit/kfs-card";
import { currentLocale } from "@/i18n/request";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";

export const metadata: Metadata = { title: "Credit" };
export const dynamic = "force-dynamic";

const APP_TONE: Record<string, BadgeTone> = { offered: "brand", accepted: "brand", disbursed: "success", rejected: "neutral", declined: "neutral", expired: "neutral", failed: "danger", cancelled: "neutral", submitted: "warning" };
const LOAN_TONE: Record<string, BadgeTone> = { active: "success", overdue: "danger", repaid: "neutral", written_off: "neutral", cancelled: "neutral" };
const short = (id: string) => id.slice(0, 8);

export default async function CreditPage() {
  const session = await requireSeller("/credit");
  const [t, locale] = await Promise.all([getTranslations("credit"), currentLocale()]);
  const res = await load(() => getCreditOverview(actorOf(session)));
  if (!res.ok) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{res.error}</Alert></div>;
  const o = res.data;
  const date = (iso: string) => formatDate(iso, locale);
  if (!o.enabled) return <div className="space-y-6"><PageHeader title={t("title")} description={t("description")} /><Alert tone="info">{t("notAvailable")}</Alert></div>;
  const openApps = o.applications.filter((a) => a.status === "offered");
  const otherApps = o.applications.filter((a) => a.status !== "offered");
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <Alert tone="info">{t("lenderNote", { lender: o.lender.name })}</Alert>

      <section aria-labelledby="consent-h">
        <Card>
          <CardHeader><CardTitle id="consent-h">{t("consent.heading")}</CardTitle></CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p>{o.consented ? t("consent.on") : t("consent.off")}</p>
            {o.consented ? <p className="text-muted">{t("consent.withdrawNote")}</p> : null}
            <ConsentForm granted={o.consented} />
          </CardBody>
        </Card>
      </section>

      {o.consented ? (
        <>
          <ScoreSection score={o.score} t={t} date={date} />
          <section aria-labelledby="eligible-h">
            <Card>
              <CardHeader><CardTitle id="eligible-h">{t("eligible.heading")}</CardTitle></CardHeader>
              <CardBody className="space-y-4 text-sm">
                <p className="text-muted">{t("eligible.intro")}</p>
                {o.blockers.length > 0 ? <Alert tone="warning">{t("eligible.blocked", { reasons: o.blockers.map((b) => (t.has(`blockers.${b}`) ? t(`blockers.${b}`) : b)).join("; ") })}</Alert> : null}
                {o.eligible.length === 0 && o.blockers.length === 0 ? <p>{t("eligible.none")}</p> : null}
                <ul className="grid gap-4">
                  {o.eligible.map((e) => (
                    <li key={e.escrowId} className="rounded-card border border-line p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="font-semibold text-ink">{t("eligible.order", { id: short(e.orderId) })}</p>
                        {e.applied ? <Badge tone="warning">{t("eligible.applied")}</Badge> : null}
                      </div>
                      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div><dt className="text-muted">{t("eligible.orderValue")}</dt><dd className="font-medium"><Money paise={e.amountPaise} /></dd></div>
                        <div><dt className="text-muted">{t("eligible.maxAdvance")}</dt><dd className="font-medium"><Money paise={e.maxAdvancePaise} /></dd></div>
                      </dl>
                      {!e.applied ? <div className="mt-3"><ApplyForm escrowId={e.escrowId} maxRupees={Math.floor(e.maxAdvancePaise / 100)} tenors={TENORS.invoice_financing} /></div> : null}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          </section>
        </>
      ) : null}

      <section aria-labelledby="apps-h" className="space-y-3">
        <h2 id="apps-h" className="text-lg font-semibold text-ink">{t("applications.heading")}</h2>
        {o.applications.length === 0 ? <EmptyState title={t("applications.empty")} /> : null}
        {openApps.map((a) => <OfferApplication key={a.id} a={a} t={t} date={date} lender={o.lender.name} />)}
        <ul className="grid gap-3">
          {otherApps.map((a) => (
            <li key={a.id}>
              <Card>
                <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <div>
                    <p className="font-semibold text-ink">{t(`applications.product.${a.product}`)} · {t("loans.order", { id: short(a.orderId) })}</p>
                    <p className="text-muted">{t("applications.created", { date: date(a.createdAt) })}{a.reason === "consent_withdrawn" ? ` · ${t("applications.reasonCancelled")}` : ""}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Money paise={a.amountPaise} />
                    <Badge tone={APP_TONE[a.status] ?? "neutral"}><span className="sr-only">{t("applications.statusLabel")}: </span>{t(`applications.status.${a.status}`)}</Badge>
                  </div>
                  {a.status === "accepted" && a.partner === "mock" && process.env.NODE_ENV !== "production" ? <SimulateForm applicationId={a.id} /> : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="loans-h" className="space-y-3">
        <h2 id="loans-h" className="text-lg font-semibold text-ink">{t("loans.heading")}</h2>
        {o.loans.length === 0 ? <EmptyState title={t("loans.empty")} /> : <ul className="grid gap-3">{o.loans.map((l) => <LoanRow key={l.id} l={l} q={o.exitQuotes[l.id]} t={t} date={date} />)}</ul>}
      </section>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations>>;

function ScoreSection({ score, t, date }: { score: ScoreView | null; t: T; date: (iso: string) => string }) {
  return (
    <section aria-labelledby="score-h">
      <Card>
        <CardHeader><CardTitle id="score-h">{t("score.heading")}</CardTitle></CardHeader>
        <CardBody className="space-y-4 text-sm">
          {!score ? <p>{t("score.none")}</p> : (
            <>
              <div className="flex flex-wrap items-baseline gap-3">
                <p className="text-3xl font-bold text-ink" aria-label={t("score.value", { score: score.score })}>{score.score}</p>
                <Badge tone={score.score >= 600 ? "success" : score.score >= 500 ? "warning" : "danger"}><span className="sr-only">{t("score.band")}: </span>{t(`score.bands.${score.band}`)}</Badge>
                <p className="text-muted">{t("score.model", { version: score.modelVersion })} · {t("score.updated", { date: date(score.computedAt) })}</p>
              </div>
              <div>
                <h3 className="font-semibold text-ink">{t("score.reasonsHeading")}</h3>
                <ul className="mt-2 space-y-2">
                  {score.reasons.map((r) => (
                    <li key={`${r.code}-${r.direction}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0">
                      <span><span className="font-medium text-ink">{r.direction === "positive" ? t("score.positive") : t("score.negative")}:</span> {t(`reasons.${r.code}`)}</span>
                      <span className="text-muted">{t("score.points", { points: r.points, max: r.maxPoints })}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-muted">{t("score.explain")}</p>
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

function OfferApplication({ a, t, date, lender }: { a: ApplicationView; t: T; date: (iso: string) => string; lender: string }) {
  const offer = a.offers.find((x) => x.status === "open");
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="font-semibold text-ink">{t(`applications.product.${a.product}`)} · {t("loans.order", { id: short(a.orderId) })}</p>
          <Badge tone="brand"><span className="sr-only">{t("applications.statusLabel")}: </span>{t("applications.status.offered")}</Badge>
        </div>
        {offer ? (
          <>
            <KfsCard kfs={offer.kfs} expiresAt={offer.expiresAt} date={date} />
            <AcceptForm offerId={offer.id} kfsVersion={offer.kfs.version} lender={lender} />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function LoanRow({ l, q, t, date }: { l: LoanView; q?: CoolingOffQuote; t: T; date: (iso: string) => string }) {
  return (
    <li>
      <Card>
        <CardBody className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-semibold text-ink">{t(`applications.product.${l.product}`)} · {t("loans.order", { id: short(l.orderId) })}</p>
            <div className="flex items-center gap-3">
              {l.dpd > 0 && l.status === "overdue" ? <span className="text-danger">{t("loans.dpd", { days: l.dpd })}</span> : null}
              <Badge tone={LOAN_TONE[l.status] ?? "neutral"}><span className="sr-only">{t("loans.statusLabel")}: </span>{t(`loans.status.${l.status}`)}</Badge>
            </div>
          </div>
          <dl className="grid gap-2 sm:grid-cols-4">
            <div><dt className="text-muted">{t("loans.principal")}</dt><dd className="font-medium"><Money paise={l.principalPaise} /></dd></div>
            <div><dt className="text-muted">{t("loans.repaid")}</dt><dd className="font-medium"><Money paise={l.repaidPaise} /></dd></div>
            <div><dt className="text-muted">{t("loans.outstanding")}</dt><dd className="font-medium"><Money paise={l.outstandingPaise} /></dd></div>
            <div><dt className="text-muted">{t("loans.due", { date: date(l.dueAt) })}</dt></div>
          </dl>
          {l.status === "cancelled" ? (
            <div className="rounded-card border border-line p-3">
              <p>{l.cancelReason === "cooling_off" ? t("loans.cancelledExit") : t("loans.cancelledPartner")}</p>
              {l.exitAmountPaise !== null ? <p className="mt-1"><span className="text-muted">{t("loans.exitOwed")}: </span><span className="font-medium"><Money paise={l.exitAmountPaise} /></span></p> : null}
            </div>
          ) : null}
          {q ? <ExitPanel q={q} l={l} t={t} date={date} /> : null}
        </CardBody>
      </Card>
    </li>
  );
}

/** Cooling-off exit offer (RBI): exact amount first, then a separate explicit confirmation. */
function ExitPanel({ q, l, t, date }: { q: CoolingOffQuote; l: LoanView; t: T; date: (iso: string) => string }) {
  return (
    <section aria-label={t("exit.heading")} className="rounded-card border border-line p-4">
      <h3 className="font-semibold text-ink">{t("exit.heading")}</h3>
      <p className="mt-1 text-muted">{t("exit.intro", { date: date(q.windowEndsAt) })}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div><dt className="text-muted">{t("exit.principal")}</dt><dd className="font-medium"><Money paise={q.principalPaise} /></dd></div>
        <div><dt className="text-muted">{t("exit.interest", { days: q.interestDays })}</dt><dd className="font-medium"><Money paise={q.interestPaise} /></dd></div>
        <div><dt className="text-muted">{q.feesWaived ? t("exit.feesWaived") : t("exit.fees")}</dt><dd className="font-medium"><Money paise={q.feesPaise} /></dd></div>
        {q.repaidPaise > 0 ? <div><dt className="text-muted">{t("loans.repaid")}</dt><dd className="font-medium"><Money paise={q.repaidPaise} /></dd></div> : null}
        <div><dt className="text-muted">{t("exit.total")}</dt><dd className="font-semibold text-ink"><Money paise={q.payablePaise} /></dd></div>
      </dl>
      <p className="mt-3 text-muted">{t(l.product === "bnpl" ? "exit.note_bnpl" : "exit.note_invoice_financing")}</p>
      <div className="mt-3"><ExitLoanForm loanId={l.id} payablePaise={q.payablePaise} lender={q.lenderName} /></div>
    </section>
  );
}
