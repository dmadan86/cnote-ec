import { Breadcrumbs, Container } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ARTICLES, articleById, articleIn, helpPath, LINKS } from "@/features/help/articles";
import { helpCrumbs } from "@/features/help/crumbs";
import { LOCALES } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { localizedAlternates } from "@/lib/seo-i18n";

type Props = { params: Promise<{ locale: string; topic: string; article: string }> };

// Statically generated for every locale and article; anything else is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  return LOCALES.flatMap((locale) => ARTICLES.map((a) => ({ locale, topic: a.topic, article: a.id })));
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { topic, article } = await props.params;
  const a = articleIn(topic, article);
  if (!a) return {};
  const t = await getTranslations({ locale, namespace: "help" });
  return { title: t(`a.${a.id}.title`), description: t(`a.${a.id}.summary`), alternates: localizedAlternates(helpPath(a), locale) };
}

export default async function HelpArticlePage(props: Props) {
  const locale = await resolveLocale(props.params);
  const { topic, article } = await props.params;
  const a = articleIn(topic, article);
  if (!a) notFound();
  const t = await getTranslations({ locale, namespace: "help" });
  const k = (key: string) => t(`a.${a.id}.${key}`);
  const topicTitle = t(`topic.${a.topic}.title`);
  const { items, ld } = helpCrumbs(t, locale, { id: a.topic, title: topicTitle }, { id: a.id, title: k("title") });
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [{ "@type": "Question", name: k("q"), acceptedAnswer: { "@type": "Answer", text: k("ans") } }],
  };
  const related = a.related.map(articleById).filter((r) => r !== undefined);
  return (
    <Container className="max-w-3xl py-8 sm:py-10">
      <JsonLd data={[ld, faq]} />
      <Breadcrumbs linkComponent={Link} label={t("breadcrumbLabel")} items={items} />
      <article className="mt-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{k("title")}</h1>
        <p className="mt-2 text-base text-muted">{k("summary")}</p>

        <section aria-labelledby="s1" className="mt-8">
          <h2 id="s1" className="text-lg font-bold text-ink">
            {k("h1")}
          </h2>
          <p className="mt-2 text-base leading-relaxed text-ink">{k("p1")}</p>
        </section>
        <section aria-labelledby="s2" className="mt-8">
          <h2 id="s2" className="text-lg font-bold text-ink">
            {k("h2")}
          </h2>
          <p className="mt-2 text-base leading-relaxed text-ink">{k("p2")}</p>
        </section>

        {a.links.length ? (
          <section aria-labelledby="links" className="mt-8">
            <h2 id="links" className="text-lg font-bold text-ink">
              {t("usefulLinks")}
            </h2>
            <ul className="mt-2 flex flex-col gap-1">
              {a.links.map((l) => (
                <li key={l}>
                  <Link href={LINKS[l]} className="inline-flex min-h-8 items-center font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-900">
                    {t(`link.${l}`)}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="faq" className="mt-10 rounded-card border border-line bg-surface p-5">
          <h2 id="faq" className="text-lg font-bold text-ink">
            {t("faqHeading")}
          </h2>
          <h3 className="mt-3 text-base font-semibold text-ink">{k("q")}</h3>
          <p className="mt-1 text-base leading-relaxed text-ink">{k("ans")}</p>
        </section>
      </article>

      {related.length ? (
        <nav aria-labelledby="related" className="mt-10">
          <h2 id="related" className="text-lg font-bold text-ink">
            {t("relatedHeading")}
          </h2>
          <ul className="mt-3 divide-y divide-line rounded-card border border-line bg-surface">
            {related.map((r) => (
              <li key={r.id}>
                <Link href={helpPath(r)} className="flex min-h-12 items-center px-4 py-3 text-base font-semibold text-ink hover:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600">
                  {t(`a.${r.id}.title`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <p className="mt-8">
        <Link href={`/help/${a.topic}`} className="inline-flex min-h-8 items-center font-semibold text-brand-700 underline underline-offset-2">
          {t("backToTopic", { topic: topicTitle })}
        </Link>
      </p>
    </Container>
  );
}
