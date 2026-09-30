import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Badge, buttonClasses, Container } from "@cnote/ui";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { localizedAlternates } from "@/lib/seo-i18n";

// Slugs with copy in messages `comingSoon.<slug>` (title) and `comingSoon.<slug>-desc` (description).
const FEATURES = ["templates-design", "ai-design", "ai-tools", "business-services", "resources", "templates"];

// Static content: prerender every known feature page (unknown slugs 404).
export const dynamicParams = false;
export function generateStaticParams() {
  return FEATURES.map((feature) => ({ feature }));
}

export async function generateMetadata(props: PageProps<"/[locale]/coming-soon/[feature]">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { feature } = await props.params;
  const t = await getTranslations({ locale, namespace: "comingSoon" });
  if (!FEATURES.includes(feature)) return { title: t("fallbackTitle") };
  return { title: t("titleSuffix", { title: t(feature) }), alternates: localizedAlternates(`/coming-soon/${feature}`, locale) };
}

export default async function ComingSoonPage(props: PageProps<"/[locale]/coming-soon/[feature]">) {
  const locale = await resolveLocale(props.params);
  const { feature } = await props.params;
  if (!FEATURES.includes(feature)) notFound();
  const t = await getTranslations({ locale, namespace: "comingSoon" });
  return (
    <Container className="py-16 lg:py-24">
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 text-center">
        <span className="inline-flex size-14 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <Sparkles className="size-7" aria-hidden />
        </span>
        <Badge tone="brand">{t("badge")}</Badge>
        <h1 className="text-3xl font-extrabold tracking-tight text-ink">{t(feature)}</h1>
        <p className="text-base text-muted">{t(`${feature}-desc`)}</p>
        <p className="text-sm text-muted">{t("note")}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Link href="/search" className={buttonClasses("primary", "lg")}>
            {t("searchProducts")}
          </Link>
          <Link href="/rfq/new" className={buttonClasses("accent", "lg")}>
            {t("requestQuote")}
          </Link>
        </div>
      </div>
    </Container>
  );
}
