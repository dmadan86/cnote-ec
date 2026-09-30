import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, EmptyState, buttonClasses } from "@cnote/ui";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { localizedAlternates } from "@/lib/seo-i18n";
import { localizePath } from "@/i18n/config";
import { categoryPath } from "@/lib/paths";
import { breadcrumbLd } from "@/lib/schema";
import { CategoryIcon } from "@/features/search/category-icon";
import { loadCategories } from "@/features/search/data";

export const revalidate = 900;

export async function generateMetadata(props: PageProps<"/[locale]/categories">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "categories" });
  const alternates = localizedAlternates("/categories", locale);
  return { title: t("title"), description: t("description"), alternates, openGraph: { title: t("title"), description: t("description"), url: alternates.canonical } };
}

export default async function CategoriesPage(props: PageProps<"/[locale]/categories">) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "categories" });
  const th = await getTranslations({ locale, namespace: "cards" });
  const ts = await getTranslations({ locale, namespace: "search" });
  const categories = await loadCategories();
  return (
    <Container className="py-6 lg:py-8">
      <JsonLd data={breadcrumbLd([{ name: th("home"), path: localizePath("/", locale) }, { name: t("title") }])} />
      <h1 className="text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("intro")}</p>
      <div className="mt-6">
        {categories.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((c) => (
              <li key={c.id}>
                <Link href={categoryPath(c.slug)} className="flex h-full min-h-16 items-center gap-3 rounded-card border border-line bg-surface p-4 transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-600">
                  <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                    <CategoryIcon name={c.icon} className="size-6" />
                  </span>
                  <span className="text-sm font-semibold text-ink">{c.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t("emptyTitle")} description={t("emptyText")} action={<Link href="/rfq/new" className={buttonClasses("accent")}>{ts("postRequirement")}</Link>} />
        )}
      </div>
    </Container>
  );
}
