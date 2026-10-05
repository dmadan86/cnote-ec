import { categoriesOf, type StorageCategory } from "@cnote/consent";
import { CookieSettingsButton, CookieTable } from "@cnote/next-kit/consent";
import { buttonClasses, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { SELLER_POLICY_UPDATED, SELLER_POLICY_VERSION, SELLER_STORAGE_REGISTRY } from "@/features/consent/registry";
import { CookieLinks } from "@/features/consent/settings-link";
import { Logo } from "@/features/shell/logo";
import { LanguageSwitcher } from "@/i18n/language-switcher";
import { intlTag } from "@/i18n/config";
import { APP_NAME } from "@/lib/brand";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("consent");
  return { title: t("policyTitle"), description: t("policyDescription", { site: APP_NAME }) };
}

/** Where the Grievance Officer page lives: the marketplace (buyer web), the data fiduciary's single grievance channel. */
const MARKETPLACE_ORIGIN = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/**
 * Seller cookie policy (DPDP Act 2023 s.5 notice; ePrivacy Art 5(3)). Public, localised in all 8 seller languages. The table is
 * rendered from the same registry as the preferences dialog (features/consent/registry.ts), so the two can never disagree.
 * Mirrors the buyer web's /cookies page (apps/web/src/app/[locale]/cookies/page.tsx); docs/design/cookie-consent.md.
 */
export default async function SellerCookiePolicyPage() {
  const [t, locale] = await Promise.all([getTranslations("consent"), getLocale()]);
  const date = new Intl.DateTimeFormat(intlTag(locale), { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(SELLER_POLICY_UPDATED));
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-8">
        <Logo />
        <LanguageSwitcher />
      </header>
      <main className="flex-1">
        <Container className="max-w-4xl py-10">
          <PageHeader title={t("policyTitle")} description={t("policyDescription", { site: APP_NAME })} />
          <p className="mt-2 text-sm text-muted">{t("versionLine", { version: SELLER_POLICY_VERSION, date })}</p>

          <section className="mt-8" aria-labelledby="ck-what">
            <h2 id="ck-what" className="text-lg font-semibold text-ink">{t("whatTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("whatBody")}</p>
          </section>

          <section className="mt-8" aria-labelledby="ck-cats">
            <h2 id="ck-cats" className="text-lg font-semibold text-ink">{t("categoriesTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("categoriesBody", { site: APP_NAME })}</p>
          </section>

          <section className="mt-8" aria-labelledby="ck-table">
            <h2 id="ck-table" className="text-lg font-semibold text-ink">{t("tableTitle")}</h2>
            <div className="mt-4 flex flex-col gap-8">
              {categoriesOf(SELLER_STORAGE_REGISTRY).map((c: StorageCategory) => (
                <div key={c}>
                  <h3 className="text-base font-semibold text-ink">{t(`${c}Title`)}</h3>
                  <p className="mb-3 mt-1 text-sm text-muted">{t(`${c}Desc`)}</p>
                  <CookieTable registry={SELLER_STORAGE_REGISTRY} category={c} label={t(`${c}Title`)} />
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

          <section className="mt-8" aria-labelledby="ck-grv">
            <h2 id="ck-grv" className="text-lg font-semibold text-ink">{t("grievanceTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("grievanceBody")}</p>
            <p className="mt-3">
              <a href={`${MARKETPLACE_ORIGIN}/grievance`} className={buttonClasses("outline", "md", "min-h-11")}>{t("grievanceLink")}</a>
            </p>
          </section>
        </Container>
      </main>
      <footer className="px-4 pb-4 text-center sm:px-8">
        <CookieLinks />
      </footer>
    </div>
  );
}
