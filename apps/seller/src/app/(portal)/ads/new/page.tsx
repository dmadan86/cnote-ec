import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@cnote/ui";
import { getAdsConfig, getPublicRateCard, isAdsEnabled } from "@cnote/ads";
import { getTranslations } from "next-intl/server";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { istToday } from "@/features/ads/format";
import { NewCampaignForm, type CategoryChoice, type ProductChoice } from "@/features/ads/forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ads.meta");
  return { title: t("newTitle") };
}

export default async function NewCampaignPage() {
  const session = await requireSeller("/ads/new");
  const t = await getTranslations("ads");
  if (!isAdsEnabled()) return <EmptyState title={t("comingSoon.title")} description={t("comingSoon.description")} action={<Link href="/ads" className="underline">{t("comingSoon.back")}</Link>} />;
  const [listings, cats, cfg, rates] = await Promise.all([
    load(() => catalogue.listSellerListings(session.business.id)),
    load(() => catalogue.listCategories()),
    load(() => getAdsConfig()),
    load(() => getPublicRateCard()),
  ]);
  const products: ProductChoice[] = listings.ok
    ? listings.data
        .filter((l) => l.status !== "archived")
        .map((l) => {
          const ok = l.status === "published" && l.moderationStatus === "approved" && l.imageUrls.length > 0 && l.pricePaise != null;
          return { id: l.id, title: l.title, eligible: ok, note: l.status !== "published" ? t("form.note.unpublished") : l.moderationStatus !== "approved" ? t("form.note.notApproved") : !l.imageUrls.length ? t("form.note.needsPhoto") : t("form.note.needsPrice") };
        })
    : [];
  const categories: CategoryChoice[] = cats.ok ? cats.data.filter((c) => !c.prohibited).map((c) => ({ id: c.id, name: c.name })) : [];
  const defaultSearch = rates.ok ? rates.data.find((r) => r.categoryId === null && r.surface === "search") : undefined;
  const today = istToday();
  return (
    <div className="space-y-6">
      <PageHeader title={t("meta.newTitle")} description={t("form.intro")} />
      <NewCampaignForm products={products} categories={categories} minDailyRupees={cfg.ok ? cfg.data.minDailyBudgetPaise / 100 : 100} cpcSearchPaise={defaultSearch?.cpcPaise ?? null} today={today} />
    </div>
  );
}
