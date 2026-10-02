import { Container, PageHeader } from "@cnote/ui";
import { DOC_LINKS, INFO_PAGES } from "@/features/legal/docs";
import { copyHelpers, legalMetadata } from "@/features/legal/legal-doc";
import { loadCategories } from "@/features/search/data";
import { LocaleLink } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { categoryPath } from "@/lib/paths";

export const generateMetadata = (props: { params: Promise<{ locale: string }> }) => legalMetadata(props.params, "/sitemap", "sitemap");
export const revalidate = 900;

const linkCls = "inline-flex min-h-8 items-center text-sm text-brand-700 underline underline-offset-2 hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/** Human-readable sitemap (not the XML one): categories from the same read model as /categories, plus every policy and info page. */
export default async function SitemapPage(props: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(props.params);
  const { t, rich } = await copyHelpers(locale);
  const categories = await loadCategories();
  const s = (k: string) => t(`sitemap.${k}`);
  const groups = [
    { id: "sm-market", title: s("marketTitle"), links: [{ href: "/search?tab=products", label: s("marketProducts") }, { href: "/manufacturers", label: s("marketManufacturers") }, { href: "/rfq/new", label: s("marketRfq") }, { href: "/categories", label: s("allCategories") }] },
    { id: "sm-company", title: s("companyTitle"), links: INFO_PAGES.filter((p) => p.group === "company").map((p) => ({ href: DOC_LINKS[p.key], label: t(`links.${p.key}`) })) },
    { id: "sm-legal", title: s("legalTitle"), links: INFO_PAGES.filter((p) => p.group === "legal").map((p) => ({ href: DOC_LINKS[p.key], label: t(`links.${p.key}`) })) },
  ];
  return (
    <Container className="max-w-5xl py-10">
      <PageHeader title={s("title")} description={rich(t.raw("sitemap.intro") as string)} />
      <section className="mt-8" aria-labelledby="sm-cats">
        <h2 id="sm-cats" className="text-lg font-semibold text-ink">{s("categoriesTitle")}</h2>
        {categories.length ? (
          <ul className="mt-3 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((c) => (
              <li key={c.id}><LocaleLink href={categoryPath(c.slug)} className={linkCls}>{c.name}</LocaleLink></li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">{s("noCategories")}</p>
        )}
      </section>
      <div className="mt-8 grid gap-8 md:grid-cols-3">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={g.id}>
            <h2 id={g.id} className="text-lg font-semibold text-ink">{g.title}</h2>
            <ul className="mt-3">
              {g.links.map((l) => (
                <li key={l.href}><LocaleLink href={l.href} className={linkCls}>{l.label}</LocaleLink></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Container>
  );
}
