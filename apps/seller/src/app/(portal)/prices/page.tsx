import type { Metadata } from "next";
import Link from "next/link";
import { getSellerCompetitiveness } from "@cnote/prices";
import { Alert, EmptyState, PageHeader, buttonClasses } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { CompetitivenessTable } from "@/features/prices/competitiveness";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("prices"))("metaTitle") };
}
export const dynamic = "force-dynamic";

/** Premium analytics (ADR-022): each live listing vs the k-anonymous benchmark band. Gated by plan inside the module. */
export default async function PricesPage() {
  const session = await requireSeller("/prices");
  const t = await getTranslations("prices");
  const res = await load(() => getSellerCompetitiveness(session.business.id));
  const header = <PageHeader title={t("title")} description={t("description")} />;
  if (!res.ok) return <div className="space-y-6">{header}<Alert tone="danger">{res.error}</Alert></div>;
  const r = res.data;
  if (!r.enabled) return <div className="space-y-6">{header}<EmptyState title={t("disabledTitle")} description={t("disabledDescription")} /></div>;
  if (!r.premium) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={t("lockedTitle")} description={t("lockedDescription")} action={<Link href="/billing" className={buttonClasses("primary", "md", "min-h-11")}>{t("lockedAction")}</Link>} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {header}
      {r.items.length === 0 ? <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} /> : <CompetitivenessTable items={r.items} />}
    </div>
  );
}
