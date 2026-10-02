import { Breadcrumbs, Container } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { articlesOf, helpPath, isTopic, TOPIC_ICONS, TOPIC_IDS } from "@/features/help/articles";
import { helpCrumbs } from "@/features/help/crumbs";
import { LOCALES } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { localizedAlternates } from "@/lib/seo-i18n";

type Props = { params: Promise<{ locale: string; topic: string }> };

// Statically generated for every locale and topic; anything else is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  return LOCALES.flatMap((locale) => TOPIC_IDS.map((topic) => ({ locale, topic })));
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { topic } = await props.params;
  if (!isTopic(topic)) return {};
  const t = await getTranslations({ locale, namespace: "help" });
  return {
    title: t(`topic.${topic}.title`),
    description: `${t(`topic.${topic}.desc`)} ${t("topicMetaDescription", { count: articlesOf(topic).length, topic: t(`topic.${topic}.title`) })}`,
    alternates: localizedAlternates(`/help/${topic}`, locale),
  };
}

export default async function HelpTopicPage(props: Props) {
  const locale = await resolveLocale(props.params);
  const { topic } = await props.params;
  if (!isTopic(topic)) notFound();
  const t = await getTranslations({ locale, namespace: "help" });
  const title = t(`topic.${topic}.title`);
  const { items, ld } = helpCrumbs(t, locale, { id: topic, title });
  const Icon = TOPIC_ICONS[topic];
  return (
    <Container className="max-w-3xl py-8 sm:py-10">
      <JsonLd data={ld} />
      <Breadcrumbs linkComponent={Link} label={t("breadcrumbLabel")} items={items} />
      <header className="mt-6 flex items-start gap-4">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
          <Icon className="size-6" aria-hidden />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h1>
          <p className="mt-1 text-base text-muted">{t(`topic.${topic}.desc`)}</p>
        </div>
      </header>
      <ul className="mt-8 divide-y divide-line rounded-card border border-line bg-surface">
        {articlesOf(topic).map((a) => (
          <li key={a.id}>
            <Link href={helpPath(a)} className="flex min-h-12 flex-col gap-0.5 px-4 py-3 hover:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600">
              <span className="text-base font-semibold text-ink">{t(`a.${a.id}.title`)}</span>
              <span className="text-sm text-muted">{t(`a.${a.id}.summary`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Container>
  );
}
