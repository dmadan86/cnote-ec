import { listGoodsReturns, purchaseOrdersEnabled } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Container, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { ReturnRow } from "@/features/grn/views";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grn" });
  return { title: t("returns.metaTitle") };
}

const FILTERS = ["open", "all"] as const;

export default async function BuyerReturnsPage(props: { searchParams: Promise<{ filter?: string; cursor?: string }> }) {
  const sp = await props.searchParams;
  const filter = FILTERS.find((f) => f === sp.filter) ?? "open";
  const s = await requireBusiness("/buyer/returns");
  if (!purchaseOrdersEnabled()) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "grn.returns" });
  const page = await listGoodsReturns(actorOf(s), { role: "buyer", status: filter === "open" ? "open" : null, cursor: sp.cursor });
  return (
    <Container className="py-8">
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="mt-6 flex flex-col gap-5">
        <LinkTabs
          label={t("tabsLabel")}
          linkComponent={Link}
          items={FILTERS.map((f) => ({ href: f === "open" ? "/buyer/returns" : `/buyer/returns?filter=${f}`, label: t(`tab.${f}`), active: f === filter }))}
        />
        {page.items.length === 0 ? (
          <EmptyState title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <ul className="flex flex-col gap-3">
            {page.items.map((r) => <li key={r.id}><ReturnRow r={r} locale={locale} href={`/buyer/returns/${r.id}`} /></li>)}
          </ul>
        )}
        {page.nextCursor ? (
          <nav aria-label={t("paginationLabel")} className="flex justify-center">
            <Link href={`/buyer/returns?filter=${filter}&cursor=${page.nextCursor}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink">{t("older")}</Link>
          </nav>
        ) : null}
      </div>
    </Container>
  );
}
