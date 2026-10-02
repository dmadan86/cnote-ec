import { getAlertSettings, listFollowedSuppliers } from "@cnote/alerts";
import { requireSession } from "@cnote/next-kit";
import { Avatar, buttonClasses, Card, CardBody, Container, EmptyState, Money, PageHeader, TrustBadge } from "@cnote/ui";
import { MapPin } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { productPath, sellerPath } from "@/lib/paths";
import { getUiLabels } from "@/features/search/labels";
import { UnfollowButton } from "@/features/retention/unfollow-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "retention" });
  return { title: t("suppliers.title"), robots: { index: false } };
}

export default async function FollowedSuppliersPage() {
  const s = await requireSession("/buyer/suppliers");
  const locale = await getRequestLocale();
  const [t, ui, followed, settings] = await Promise.all([getTranslations({ locale, namespace: "retention" }), getUiLabels(locale), listFollowedSuppliers(s.personId), getAlertSettings(s.personId)]);
  return (
    <Container className="flex max-w-4xl flex-col gap-6 py-8">
      <PageHeader title={t("suppliers.title")} description={t("suppliers.description")} />
      {followed.length ? (
        <>
          <p className="text-sm text-muted">
            <strong className="font-semibold text-ink">{t("suppliers.digestTitle")}:</strong> {settings.followedDigest ? t("suppliers.digestOn") : t("suppliers.digestOff")}{" "}
            <Link href="/account/alerts" className="font-medium text-brand-700 underline">{t("suppliers.manageAlerts")}</Link>
          </p>
          <ul className="flex flex-col gap-4" aria-label={t("suppliers.title")}>
            {followed.map((f) => (
              <li key={f.businessId}>
                <Card>
                  <CardBody className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <Avatar name={f.name} size="lg" />
                        <div className="min-w-0">
                          <h2 className="truncate text-base font-semibold text-ink">
                            <Link href={sellerPath(f.businessId)} className="hover:text-brand-700 hover:underline">{f.name}</Link>
                          </h2>
                          {f.city || f.state ? (
                            <p className="inline-flex items-center gap-1 text-sm text-muted"><MapPin className="size-3.5" aria-hidden /> {[f.city, f.state].filter(Boolean).join(", ")}</p>
                          ) : null}
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <TrustBadge tier={f.verificationTier} badgeActive={f.badgeActive} labels={ui.trust} />
                            <span className="text-xs text-muted">{t("suppliers.followedOn", { date: formatDate(f.followedAt, locale, { dateStyle: "medium" }) })}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-start gap-2">
                        <Link href={sellerPath(f.businessId)} className={buttonClasses("outline-brand", "md", "min-h-11")}>{t("suppliers.viewProfile")}</Link>
                        <UnfollowButton businessId={f.businessId} name={f.name} />
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-ink">{t("suppliers.latest")}</h3>
                      {f.latestListings.length ? (
                        <ul aria-label={t("suppliers.listLabel", { name: f.name })} className="mt-2 grid gap-2 sm:grid-cols-3">
                          {f.latestListings.map((l) => (
                            <li key={l.id} className="rounded-lg border border-line bg-surface p-3">
                              <Link href={productPath(l)} className="line-clamp-2 text-sm font-medium text-ink hover:text-brand-700 hover:underline">{l.title}</Link>
                              <p className="mt-1 text-sm text-muted">
                                {l.pricePaise !== null ? <Money paise={l.pricePaise} unit={l.priceUnit} /> : t("suppliers.priceOnRequest")}
                              </p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-sm text-muted">{t("suppliers.noListings")}</p>
                      )}
                    </div>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          title={t("suppliers.emptyTitle")}
          description={t("suppliers.emptyText")}
          action={<Link href="/manufacturers" className={buttonClasses("primary", "md", "min-h-11")}>{t("suppliers.browse")}</Link>}
        />
      )}
    </Container>
  );
}
