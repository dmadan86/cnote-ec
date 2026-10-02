import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { billing } from "@/lib/services";
import { CancelForm } from "@/features/billing/cancel-form";
import { formatPaise } from "@/features/billing/format-paise";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("billingAnnual.cancel"))("metaTitle") };
}
export const dynamic = "force-dynamic";

/**
 * Step 2 of "cancel in 3 taps" (ADR-005): says exactly what will happen (end date, refund, credits kept and when they
 * expire), then one confirm button. The numbers come from the same function the cancellation itself uses.
 */
export default async function CancelPlanPage() {
  const session = await requireSeller("/billing/cancel");
  const t = await getTranslations("billingAnnual.cancel");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const id = session.business.id;
  const [quote, plans] = await Promise.all([load(() => billing.previewCancellation(id)), load(() => billing.listPlans())]);

  if (!quote.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("metaTitle")} />
        <Alert tone="info">{t("noPlan")}</Alert>
        <Link href="/billing" className="text-sm text-brand-700 underline">{t("back")}</Link>
      </div>
    );
  }
  const q = quote.data;
  const planName = (plans.ok ? plans.data.find((p) => p.code === q.planCode)?.name : undefined) ?? q.planCode;
  const row = "grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4";

  return (
    <div className="space-y-6">
      <PageHeader title={t("title", { plan: planName })} description={t("description")} />
      <Card>
        <CardBody className="space-y-6">
          <dl className="divide-y divide-line text-sm">
            <div className={row}>
              <dt className="font-semibold text-ink">{t("endsLabel")}</dt>
              <dd className="text-ink">{t("endsValue", { date: formatDate(q.effectiveAt, locale) })} {t("noRenew")}</dd>
            </div>
            <div className={row}>
              <dt className="font-semibold text-ink">{t("refundLabel")}</dt>
              <dd className="text-ink">{q.refundPaise > 0 ? t("refundValue", { amount: formatPaise(q.refundPaise), months: q.unusedMonths }) : t("noRefund")}</dd>
            </div>
            <div className={row}>
              <dt className="font-semibold text-ink">{t("creditsLabel")}</dt>
              <dd className="space-y-1 text-ink">
                {q.creditsKept > 0 ? (
                  <>
                    <p>{t("creditsValue", { count: q.creditsKept })}</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-muted">
                      {q.creditLots.map((l) => <li key={l.id}>{t("lot", { count: l.remaining, date: formatDate(l.expiresAt, locale) })}</li>)}
                    </ul>
                  </>
                ) : <p>{t("noCredits")}</p>}
              </dd>
            </div>
          </dl>
          <CancelForm />
        </CardBody>
      </Card>
    </div>
  );
}
