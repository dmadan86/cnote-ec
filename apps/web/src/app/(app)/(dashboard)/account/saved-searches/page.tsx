import { listSavedSearches } from "@cnote/alerts";
import { requireSession } from "@cnote/next-kit";
import { buttonClasses, Container, EmptyState, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { SavedSearchRow } from "@/features/retention/saved-search-row";
import { savedSearchHref } from "@/features/retention/search-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "retention" });
  return { title: t("searches.title"), robots: { index: false } };
}

export default async function SavedSearchesPage() {
  const s = await requireSession("/account/saved-searches");
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "retention" });
  const rows = await listSavedSearches(s.personId);
  return (
    <Container className="flex max-w-3xl flex-col gap-6 py-8">
      <PageHeader
        title={t("searches.title")}
        description={t("searches.description")}
        actions={<Link href="/account/alerts" className={buttonClasses("outline", "md", "min-h-11")}>{t("suppliers.manageAlerts")}</Link>}
      />
      {rows.length ? (
        <>
          <p className="text-sm text-muted">{t("searches.alertsNote")}</p>
          <ul aria-label={t("searches.listLabel")} className="flex flex-col gap-4">
            {rows.map((r) => (
              <SavedSearchRow
                key={r.id}
                s={{
                  id: r.id,
                  name: r.name || t("searches.allProducts"),
                  query: r.query,
                  frequency: r.frequency,
                  href: savedSearchHref(r),
                  lastChecked: r.lastRunAt ? formatDate(r.lastRunAt, locale, { dateStyle: "medium" }) : null,
                  created: formatDate(r.createdAt, locale, { dateStyle: "medium" }),
                }}
              />
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          title={t("searches.emptyTitle")}
          description={t("searches.emptyText")}
          action={<Link href="/search" className={buttonClasses("primary", "md", "min-h-11")}>{t("searches.startSearch")}</Link>}
        />
      )}
    </Container>
  );
}
