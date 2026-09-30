import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Download, Plus, Upload } from "lucide-react";
import { Alert, Card, CardBody, EmptyState, Money, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { ListingStatusBadges } from "@/features/listings/status-badges";
import { versionSummary } from "@/features/listings/version-utils";
import { ListingRowActions } from "@/features/listings/row-actions";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("listings.meta"))("list") };
}

export default async function ListingsPage() {
  const t = await getTranslations("listings");
  const session = await requireSeller("/listings");
  const res = await load(() => catalogue.listSellerListings(session.business.id));
  const summaries = new Map<string, string>();
  if (res.ok) {
    await Promise.all(
      res.data.filter((l) => l.status !== "archived").map(async (l) => {
        try {
          summaries.set(l.id, versionSummary(await catalogue.getVersionOverview(session.business.id, l.id), t));
        } catch {
          /* summary is optional */
        }
      }),
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        description={t("list.description")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/listings/import" className={buttonClasses("outline", "md", "min-h-11")}>
              <Upload className="size-4" aria-hidden /> {t("list.import")}
            </Link>
            <Link href="/listings/export" className={buttonClasses("outline", "md", "min-h-11")}>
              <Download className="size-4" aria-hidden /> {t("list.export")}
            </Link>
            <Link href="/listings/new" className={buttonClasses("primary", "md", "min-h-11")}>
              <Plus className="size-4" aria-hidden /> {t("list.newListing")}
            </Link>
          </div>
        }
      />
      {!res.ok ? (
        <Alert tone="danger">{res.error}</Alert>
      ) : res.data.length === 0 ? (
        <EmptyState
          title={t("list.emptyTitle")}
          description={t("list.emptyDesc")}
          action={<Link href="/listings/new" className={buttonClasses("primary", "lg")}>{t("list.emptyCta")}</Link>}
        />
      ) : (
        <ul className="grid gap-3">
          {res.data.map((l) => (
            <li key={l.id}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="truncate font-semibold text-ink">{l.title}</h2>
                      <p className="text-sm text-muted">{l.category.name}</p>
                    </div>
                    <div className="text-sm">
                      {l.pricePaise != null ? <Money paise={l.pricePaise} unit={l.priceUnit} /> : <span className="text-muted">{t("list.askPrice")}</span>}
                      {l.moq ? <p className="text-muted">{t("list.minOrder", { qty: l.moq, unit: l.moqUnit ?? "" })}</p> : null}
                    </div>
                  </div>
                  <ListingStatusBadges listing={l} summary={summaries.get(l.id)} />
                  {l.moderationStatus === "rejected" && l.moderationReason ? <p className="text-sm text-danger">{l.moderationReason}</p> : null}
                  <div className="flex flex-wrap items-start gap-2">
                    {l.status !== "archived" ? (
                      <Link href={`/listings/${l.id}/edit`} className={buttonClasses("outline", "sm", "min-h-11")}>
                        {t("list.edit")}
                      </Link>
                    ) : null}
                    <ListingRowActions id={l.id} canPublish={l.status === "draft" && l.moderationStatus !== "review"} canArchive={l.status !== "archived"} />
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
