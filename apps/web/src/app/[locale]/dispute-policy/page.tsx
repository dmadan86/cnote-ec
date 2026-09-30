import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { resolveLocale } from "@/i18n/server";
import { localizedAlternates } from "@/lib/seo-i18n";

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "disputes" });
  return { title: t("policyTitle"), description: t("policyDescription"), alternates: localizedAlternates("/dispute-policy", locale) };
}
export const revalidate = 3600;

const STEPS = [1, 2, 3, 4, 5] as const;

/** ADR-013: the published dispute policy and appeal route. Static and localized (all 8 locales). */
export default async function DisputePolicyPage(props: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "disputes" });
  return (
    <Container className="max-w-3xl py-10">
      <PageHeader title={t("policyHeading")} description={t("policyIntro")} />
      <ol className="mt-8 flex flex-col gap-5">
        {STEPS.map((n) => (
          <li key={n}>
            <h2 className="text-lg font-semibold text-ink">{t(`step${n}Title`)}</h2>
            <p className="mt-1 text-sm text-muted">{t(`step${n}Body`)}</p>
          </li>
        ))}
      </ol>
      <section className="mt-8" aria-labelledby="appeal-h">
        <h2 id="appeal-h" className="text-lg font-semibold text-ink">{t("appealTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("appealBody")}</p>
      </section>
      <div className="mt-8"><Alert tone="info">{t("legalNote")}</Alert></div>
      <p className="mt-6"><Link href="/buyer/orders" className={buttonClasses("outline", "md", "min-h-11")}>{t("reportProblem")}</Link></p>
    </Container>
  );
}
