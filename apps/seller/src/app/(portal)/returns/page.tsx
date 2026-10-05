import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader, type BadgeTone } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { day, inr } from "@/features/purchase-orders/views";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("goodsReturns"))("metaTitle") };
}

const TONE: Record<string, BadgeTone> = { requested: "warning", approved: "brand", rejected: "danger", cancelled: "neutral", shipped: "brand", received: "brand", credited: "success" };
const FILTERS = ["open", "all"] as const;

export default async function ReturnsInboxPage({ searchParams }: { searchParams: Promise<{ filter?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f === sp.filter) ?? "open";
  const session = await requireSeller("/returns");
  const t = await getTranslations("goodsReturns");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  if (!enquiry.purchaseOrdersEnabled()) return <Alert tone="info">{t("disabled")}</Alert>;
  const res = await load(() => enquiry.listGoodsReturns(actorOf(session), { role: "seller", status: filter === "open" ? "open" : null, cursor: sp.cursor }));
  if (!res.ok) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{res.error}</Alert></div>;
  const { items, nextCursor, counts } = res.data;
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {counts.actionNeeded > 0 ? <Alert tone="info">{t("actionNeeded", { count: counts.actionNeeded })}</Alert> : null}
      <LinkTabs
        label={t("tabsLabel")}
        linkComponent={Link}
        items={FILTERS.map((f) => ({ href: f === "open" ? "/returns" : `/returns?filter=${f}`, label: t(`tab.${f}`), active: f === filter }))}
      />
      {items.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <ul className="grid gap-3">
          {items.map((r) => (
            <li key={r.id}>
              <Link href={`/returns/${r.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink"><span className="font-mono">{r.number}</span> · {r.buyerName}</p>
                      <p className="mt-0.5 text-xs text-muted">{t("meta", { units: r.units, amount: inr(r.estimatedPaise), date: day(r.createdAt.slice(0, 10), locale), po: r.purchaseOrderNumber })}</p>
                    </div>
                    <Badge tone={TONE[r.status] ?? "neutral"}>{t(`status.${r.status}`)}</Badge>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <nav aria-label={t("paginationLabel")} className="flex justify-center">
          <Link href={`/returns?filter=${filter}&cursor=${nextCursor}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink">{t("older")}</Link>
        </nav>
      ) : null}
    </div>
  );
}
