import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@cnote/ui";
import { getAdsConfig, getPublicRateCard, isAdsEnabled } from "@cnote/ads";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { istToday } from "@/features/ads/format";
import { NewCampaignForm, type CategoryChoice, type ProductChoice } from "@/features/ads/forms";

export const metadata: Metadata = { title: "New ad campaign" };

export default async function NewCampaignPage() {
  const session = await requireSeller("/ads/new");
  if (!isAdsEnabled()) return <EmptyState title="Coming soon" description="Advertising is not switched on yet." action={<Link href="/ads" className="underline">Back to Ads</Link>} />;
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
          return { id: l.id, title: l.title, eligible: ok, note: l.status !== "published" ? "Not published." : l.moderationStatus !== "approved" ? "Not approved yet." : !l.imageUrls.length ? "Needs an approved photo." : "Needs a price." };
        })
    : [];
  const categories: CategoryChoice[] = cats.ok ? cats.data.filter((c) => !c.prohibited).map((c) => ({ id: c.id, name: c.name })) : [];
  const defaultSearch = rates.ok ? rates.data.find((r) => r.categoryId === null && r.surface === "search") : undefined;
  const today = istToday();
  return (
    <div className="space-y-6">
      <PageHeader title="New ad campaign" description="Set a budget, choose products and keywords, and send it for review. You are charged only for real clicks." />
      <NewCampaignForm products={products} categories={categories} minDailyRupees={cfg.ok ? cfg.data.minDailyBudgetPaise / 100 : 100} cpcSearchPaise={defaultSearch?.cpcPaise ?? null} today={today} />
    </div>
  );
}
