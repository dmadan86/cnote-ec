import { Breadcrumbs, Container } from "@cnote/ui";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { ARTICLES, helpPath, popularArticles, TOPIC_ICONS, TOPIC_IDS, articlesOf } from "@/features/help/articles";
import { helpCrumbs } from "@/features/help/crumbs";
import { HelpSearch, type HelpSearchItem } from "@/features/help/help-search";
import type { Locale } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { IST } from "@/i18n/html-shell";
import { JsonLd } from "@/lib/json-ld";
import { localizedAlternates } from "@/lib/seo-i18n";

// Fully static: content is code + message catalogues, so the page is generated at build time (no revalidate).
export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "help" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: localizedAlternates("/help", locale) };
}

export default async function HelpCentrePage(props: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "help" });
  const { items: crumbs, ld } = helpCrumbs(t, locale);

  const topicTitle = (id: string) => t(`topic.${id}.title`);
  const items: HelpSearchItem[] = ARTICLES.map((a) => ({ id: a.id, href: helpPath(a), title: t(`a.${a.id}.title`), summary: t(`a.${a.id}.summary`), topicTitle: topicTitle(a.topic) }));
  // Only the few strings the client search needs reach the browser (not the whole article catalogue).
  const searchMessages = { help: Object.fromEntries(["searchLabel", "searchPlaceholder", "clearSearch", "resultsCount", "noResults"].map((k) => [k, (t.raw(k) as string)])) };

  return (
    <Container className="max-w-5xl py-8 sm:py-10">
      <JsonLd data={ld} />
      <Breadcrumbs linkComponent={Link} label={t("breadcrumbLabel")} items={crumbs} />
      <header className="mt-6 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">{t("heroTitle")}</h1>
        <p className="mx-auto mt-2 max-w-xl text-base text-muted">{t("heroSubtitle")}</p>
      </header>
      <div className="mt-6">
        <NextIntlClientProvider locale={locale} messages={searchMessages} timeZone={IST}>
          <HelpSearch items={items}>
            <section aria-labelledby="help-topics" className="mt-10">
              <h2 id="help-topics" className="text-xl font-bold text-ink">
                {t("topicsHeading")}
              </h2>
              <ul className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {TOPIC_IDS.map((id) => {
                  const Icon = TOPIC_ICONS[id];
                  return (
                    <li key={id}>
                      <Link href={`/help/${id}`} className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-5 hover:border-brand-600 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
                        <span className="inline-flex size-10 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                          <Icon className="size-5" aria-hidden />
                        </span>
                        <span className="text-base font-semibold text-ink">{topicTitle(id)}</span>
                        <span className="text-sm text-muted">{t(`topic.${id}.desc`)}</span>
                        <span className="mt-auto pt-1 text-xs font-medium text-brand-700">{t("articleCount", { count: articlesOf(id).length })}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section aria-labelledby="help-popular" className="mt-12">
              <h2 id="help-popular" className="text-xl font-bold text-ink">
                {t("popularHeading")}
              </h2>
              <ul className="mt-4 divide-y divide-line rounded-card border border-line bg-surface">
                {popularArticles().map((a) => (
                  <li key={a.id}>
                    <Link href={helpPath(a)} className="flex min-h-12 flex-col gap-0.5 px-4 py-3 hover:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600">
                      <span className="text-base font-semibold text-ink">{t(`a.${a.id}.title`)}</span>
                      <span className="text-sm text-muted">{t(`a.${a.id}.summary`)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </HelpSearch>
        </NextIntlClientProvider>
      </div>
      <StillNeedHelp locale={locale} />
    </Container>
  );
}

async function StillNeedHelp({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "help" });
  return (
    <section aria-labelledby="help-still" className="mt-12 rounded-card bg-brand-50 p-6">
      <h2 id="help-still" className="text-lg font-bold text-ink">
        {t("stillTitle")}
      </h2>
      <p className="mt-1 text-sm text-ink">{t("stillBody")}</p>
      <p className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
        <Link href="/grievance" className="inline-flex min-h-6 items-center text-brand-700 underline underline-offset-2">
          {t("stillGrievance")}
        </Link>
        <Link href="/report" className="inline-flex min-h-6 items-center text-brand-700 underline underline-offset-2">
          {t("stillReport")}
        </Link>
      </p>
    </section>
  );
}
