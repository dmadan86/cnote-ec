import { listPlans } from "@cnote/billing";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@cnote/ui";
import { SELLER_APP_URL } from "@/features/shell/site";
import type { Metadata } from "next";
import { resolveLocale } from "@/i18n/server";
import { localizedAlternates } from "@/lib/seo-i18n";
import { formatPaise } from "@/features/billing/format-paise";
import { PricingCalculator } from "@/features/billing/pricing-calculator";
import { IST } from "@/i18n/html-shell";
import { PlanCards } from "@/features/billing/plan-cards";

export async function generateMetadata(props: PageProps<"/[locale]/pricing">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "pricing" });
  return { title: t("title"), description: t("description"), alternates: localizedAlternates("/pricing", locale) };
}
export const revalidate = 300;

const PROMISES = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;

export default async function PricingPage(props: PageProps<"/[locale]/pricing">) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "pricing" });
  const plans = await listPlans();
  const t2 = await getTranslations({ locale, namespace: "pricing2" });
  // The calculator is the only client island: it receives just its own message namespace.
  const calcMessages = { pricing2: { calc: ((await getMessages({ locale })) as unknown as { pricing2: { calc: unknown } }).pricing2.calc } };
  const annualLines = Object.fromEntries(
    plans.filter((p) => p.monthlyPricePaise > 0).map((p) => [p.code, t2("annualLine", { price: formatPaise(p.annualPricePaise), percent: p.annualDiscountBps / 100 })]),
  );
  return (
    <Container className="py-10">
      <PageHeader title={t("heading")} description={t("subheading")} />
      <div className="mt-8 flex flex-col gap-10">
        <PlanCards plans={plans} sellerUrl={SELLER_APP_URL} cta={t("cta")} ctaFree={t("ctaFree")} annualLines={annualLines} />
        <div className="grid gap-6 lg:grid-cols-2">
          <NextIntlClientProvider locale={locale} messages={calcMessages} timeZone={IST}>
            <PricingCalculator plans={plans.map((p) => ({ code: p.code, name: p.name, monthlyPricePaise: p.monthlyPricePaise, monthlyCredits: p.monthlyCredits, annualDiscountBps: p.annualDiscountBps }))} />
          </NextIntlClientProvider>
          <dl className="grid gap-4 sm:grid-cols-2">
            {PROMISES.map((k) => (
              <div key={k}>
                <dt className="font-semibold text-ink">{t(`${k}t`)}</dt>
                <dd className="mt-0.5 text-sm text-muted">{t(`${k}d`)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Container>
  );
}
