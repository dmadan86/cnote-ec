import { getTranslations } from "next-intl/server";
import { Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { ConsentRecord, CookieSettingsButton, CookieTable, CATEGORIES, CONSENT_POLICY_UPDATED, CONSENT_POLICY_VERSION, type StorageCategory } from "@/features/consent";
import { EMBEDS_ENABLED } from "@/features/consent/embeds-flag";
import { SITE_NAME } from "@/features/shell/site";
import { formatDate } from "@/i18n/config";
import { resolveLocale } from "@/i18n/server";
import { localizedAlternates } from "@/lib/seo-i18n";

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "consent" });
  return { title: t("policyTitle"), description: t("policyDescription", { site: SITE_NAME }), alternates: localizedAlternates("/cookies", locale) };
}
export const revalidate = 3600;

/**
 * Cookie policy (DPDP Act 2023 s.5 notice; ePrivacy Art 5(3)). Static and localised. The table is rendered from the same
 * registry as the preferences dialog (features/consent/registry.ts), so the two can never disagree.
 */
export default async function CookiePolicyPage(props: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "consent" });
  return (
    <Container className="max-w-4xl py-10">
      <PageHeader title={t("policyTitle")} description={t("policyDescription", { site: SITE_NAME })} />
      <p className="mt-2 text-sm text-muted">{t("versionLine", { version: CONSENT_POLICY_VERSION, date: formatDate(CONSENT_POLICY_UPDATED, locale) })}</p>

      <section className="mt-8" aria-labelledby="ck-what">
        <h2 id="ck-what" className="text-lg font-semibold text-ink">{t("whatTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("whatBody")}</p>
      </section>

      <section className="mt-8" aria-labelledby="ck-cats">
        <h2 id="ck-cats" className="text-lg font-semibold text-ink">{t("categoriesTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("categoriesBody", { site: SITE_NAME })}</p>
        {EMBEDS_ENABLED ? <p className="mt-2 text-sm text-muted">{t("embedsNote")}</p> : null}
      </section>

      <section className="mt-8" aria-labelledby="ck-table">
        <h2 id="ck-table" className="text-lg font-semibold text-ink">{t("tableTitle")}</h2>
        <div className="mt-4 flex flex-col gap-8">
          {CATEGORIES.map((c: StorageCategory) => (
            <div key={c}>
              <h3 className="text-base font-semibold text-ink">{t(`${c}Title`)}</h3>
              <p className="mb-3 mt-1 text-sm text-muted">{t(`${c}Desc`)}</p>
              <CookieTable category={c} label={t(`${c}Title`)} />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8" aria-labelledby="ck-change">
        <h2 id="ck-change" className="text-lg font-semibold text-ink">{t("changeTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("changeBody")}</p>
        <p className="mt-3">
          <CookieSettingsButton label={t("openSettings")} className={buttonClasses("outline-brand", "md", "min-h-11")} />
        </p>
      </section>

      <section className="mt-8" aria-labelledby="ck-gpc">
        <h2 id="ck-gpc" className="text-lg font-semibold text-ink">{t("gpcTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("gpcBody")}</p>
      </section>

      <section className="mt-8" aria-labelledby="ck-proof">
        <h2 id="ck-proof" className="text-lg font-semibold text-ink">{t("proofTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("proofBody")}</p>
        <ConsentRecord showEmpty className="mt-4" />
      </section>

      <section className="mt-8" aria-labelledby="ck-grv">
        <h2 id="ck-grv" className="text-lg font-semibold text-ink">{t("grievanceTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("grievanceBody")}</p>
        <p className="mt-3">
          <Link href="/grievance" className={buttonClasses("outline", "md", "min-h-11")}>{t("grievanceLink")}</Link>
        </p>
      </section>
    </Container>
  );
}
