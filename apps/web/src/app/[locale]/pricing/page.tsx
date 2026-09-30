import { listPlans } from "@cnote/billing";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { resolveLocale } from "@/i18n/server";
import { localizedAlternates } from "@/lib/seo-i18n";
import { CreditCalculator } from "@/features/billing/credit-calculator";
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
  return (
    <Container className="py-10">
      <PageHeader title={t("heading")} description={t("subheading")} />
      <div className="mt-8 flex flex-col gap-10">
        <PlanCards plans={plans} />
        <div className="grid gap-6 lg:grid-cols-2">
          <CreditCalculator plans={plans} />
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
