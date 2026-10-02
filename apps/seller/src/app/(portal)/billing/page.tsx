import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Money, PageHeader, Stat } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate, formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { billing } from "@/lib/services";
import { formatPaise } from "@/features/billing/format-paise";
import { SubscribeButton } from "@/features/billing/plan-actions";
import { PricingCalculator } from "@/features/billing/pricing-calculator";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("billing"))("metaTitle") };
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSeller("/billing");
  const sp = await searchParams;
  const t = await getTranslations("billing");
  const ta = await getTranslations("billingAnnual");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const id = session.business.id;
  const [balance, sub, plans, ledger, invoices] = await Promise.all([
    load(() => billing.getBalance(id)),
    load(() => billing.getActiveSubscription(id)),
    load(() => billing.listPlans()),
    load(() => billing.getLedger(id, 30)),
    load(() => billing.listInvoices({ businessId: id }, { limit: 20 })),
  ]);
  const packs = billing.listCreditPacks();
  const refundedPaise = Math.max(0, Number.parseInt(one(sp.refund) ?? "0", 10) || 0);
  const gstRateBps = billing.platformSupplier().gstRateBps;
  const activeCode = sub.ok && sub.data?.status === "active" ? sub.data.planCode : null;
  const activePlan = plans.ok ? plans.data.find((p) => p.code === activeCode) : undefined;

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />

      {one(sp.cancelled) === "1" ? (
        <Alert tone="success">
          <p className="font-semibold">{ta("cancelled.title")}</p>
          <p>{refundedPaise > 0 ? ta("cancelled.refund", { amount: formatPaise(refundedPaise) }) : ta("cancelled.noRefund")} {ta("cancelled.creditsKept")}</p>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t("leadCredits")} value={balance.ok ? balance.data : "-"} hint={t("leadCreditsHint")} />
        <Stat
          label={t("currentPlan")}
          value={activePlan?.name ?? (activeCode ?? t("none"))}
          hint={sub.ok && sub.data && sub.data.status === "active" ? t("planRuns", { date: formatDate(sub.data.periodEnd, locale) }) : undefined}
        />
      </div>
      {!balance.ok ? <Alert tone="danger">{balance.error}</Alert> : null}

      {sub.ok && sub.data?.status === "active" && activeCode && activePlan && activePlan.monthlyPricePaise > 0 ? (
        <Link href="/billing/cancel" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-ink hover:bg-canvas">{t("cancelPlan")}</Link>
      ) : null}

      <section aria-labelledby="plans" className="space-y-3">
        <h2 id="plans" className="text-lg font-bold text-ink">{t("plans")}</h2>
        {!plans.ok ? <Alert tone="danger">{plans.error}</Alert> : (
          <ul className="grid gap-4 md:grid-cols-3">
            {plans.data.map((p) => (
              <li key={p.code}>
                <Card className="h-full">
                  <CardBody className="flex h-full flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-ink">{p.name}</h3>
                      {p.code === activeCode ? <Badge tone="success">{t("current")}</Badge> : null}
                    </div>
                    <p>{p.monthlyPricePaise === 0 ? <span className="text-2xl font-bold text-ink">{t("free")}</span> : <Money paise={p.monthlyPricePaise} unit="month" className="text-2xl" />}</p>
                    <p className="text-sm text-ink">{t("perMonthCredits", { count: p.monthlyCredits })}</p>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                    <div className="mt-auto space-y-2 pt-2">
                      <SubscribeButton planCode={p.code} current={p.code === activeCode} label={p.monthlyPricePaise === 0 ? t("switchFree") : t("buyPlan", { name: p.name })} />
                      {p.monthlyPricePaise > 0 ? (
                        <>
                          <p className="text-xs text-muted">{ta("annualOffer", { price: formatPaise(p.annualPricePaise), percent: p.annualDiscountBps / 100 })}</p>
                          <Link href={`/billing/checkout?plan=${encodeURIComponent(p.code)}&interval=annual`} className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-ink hover:bg-canvas">{ta("buyAnnual", { name: p.name })}</Link>
                        </>
                      ) : null}
                    </div>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{t("priceNote")}</p>
      </section>

      {plans.ok ? (
        <section aria-label={ta("calc.title")} className="max-w-xl">
          <PricingCalculator plans={plans.data.map((p) => ({ code: p.code, name: p.name, monthlyPricePaise: p.monthlyPricePaise, monthlyCredits: p.monthlyCredits, annualDiscountBps: p.annualDiscountBps }))} gstRateBps={gstRateBps} />
        </section>
      ) : null}

      <section aria-labelledby="packs" className="space-y-3">
        <h2 id="packs" className="text-lg font-bold text-ink">{t("buyCredits")}</h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {packs.map((p) => (
            <li key={p.id}>
              <Card className="h-full">
                <CardBody className="flex h-full flex-col gap-2">
                  <h3 className="font-semibold text-ink">{p.label}</h3>
                  <Money paise={p.pricePaise} className="text-2xl" />
                  <p className="text-xs text-muted">{t("packNote")}</p>
                  <div className="mt-auto pt-2"><Link href={`/billing/checkout?pack=${p.id}`} className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-brand-600 px-4 text-sm font-semibold text-brand-700">{t("buyPack", { count: p.credits })}</Link></div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <Card>
        <CardHeader><CardTitle>{t("invoices")}</CardTitle></CardHeader>
        <CardBody>
          {!invoices.ok ? <Alert tone="danger">{invoices.error}</Alert> : invoices.data.length === 0 ? <p className="text-sm text-muted">{t("noInvoices")}</p> : (
            <ul className="divide-y divide-line">
              {invoices.data.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink">{i.number}{i.kind === "credit_note" ? ` ${t("creditNote")}` : ""}</p>
                    <p className="text-xs text-muted">{formatDate(i.issuedAt, locale)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone={i.kind === "credit_note" ? "warning" : "success"}>{i.kind === "credit_note" ? t("refunded") : t("paid")}</Badge>
                    <Money paise={i.kind === "credit_note" ? -i.totalPaise : i.totalPaise} />
                    <a href={`/api/invoices/${i.id}`} className="inline-flex min-h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink" download>{t("invoicePdf")}</a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("creditHistory")}</CardTitle></CardHeader>
        <CardBody>
          {!ledger.ok ? <Alert tone="danger">{ledger.error}</Alert> : ledger.data.length === 0 ? <p className="text-sm text-muted">{t("noCreditActivity")}</p> : (
            <ul className="divide-y divide-line">
              {ledger.data.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink">{t(`reason.${e.reason}`)}</p>
                    <p className="text-xs text-muted">{formatDateTime(e.createdAt, locale)}{e.expiresAt ? ` · ${t("expires", { date: formatDate(e.expiresAt, locale) })}` : ""}</p>
                  </div>
                  <span className={`font-semibold tabular-nums ${e.delta >= 0 ? "text-success" : "text-ink"}`}>{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
