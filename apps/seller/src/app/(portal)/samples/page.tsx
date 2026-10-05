import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader, type BadgeTone } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate, formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { getSellerSampleStats, listSellerSamples, samplesEnabled, type SampleStatus } from "@/lib/samples";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("samples"))("metaTitle") };
}
export const dynamic = "force-dynamic";

const TONE: Record<SampleStatus, BadgeTone> = {
  requested: "warning", accepted: "brand", declined: "neutral", dispatched: "brand", delivered: "warning", approved: "success", rejected: "danger", expired: "neutral", cancelled: "neutral",
};
const FILTERS = ["all", "open", "done"] as const;

export default async function SamplesPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter: raw } = await searchParams;
  const filter = (FILTERS as readonly string[]).includes(raw ?? "") ? (raw as (typeof FILTERS)[number]) : "all";
  const session = await requireSeller("/samples");
  const t = await getTranslations("samples");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  if (!samplesEnabled()) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="info">{t("notAvailable")}</Alert></div>;
  const actor = actorOf(session);
  const res = await load(async () => ({
    items: await listSellerSamples(actor, { filter: filter === "all" ? undefined : filter }),
    stats: (await getSellerSampleStats([actor.businessId])).get(actor.businessId),
  }));
  if (!res.ok) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{res.error}</Alert></div>;
  const { items, stats } = res.data;
  const tabLabel = { all: t("filterAll"), open: t("filterOpen"), done: t("filterDone") };
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {stats && (stats.evaluated > 0 || stats.expired > 0) ? (
        <Card>
          <CardBody className="space-y-1 text-sm">
            <h2 className="font-semibold text-ink">{t("statsTitle")}</h2>
            <p className="text-ink">
              {stats.approvalRate !== null ? t("statsApproval", { pct: Math.round(stats.approvalRate * 100), count: stats.evaluated }) : t("statsNotEnough", { count: stats.evaluated })}
            </p>
            {stats.expired > 0 ? <p className="text-muted">{t("statsExpired", { count: stats.expired })}</p> : null}
          </CardBody>
        </Card>
      ) : null}
      <nav aria-label={t("filterLabel")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/samples" : `/samples?filter=${f}`}
            aria-current={f === filter ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600 ${f === filter ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line bg-surface text-ink"}`}
          >
            {tabLabel[f]}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} /> : (
        <ul className="grid gap-3">
          {items.map((x) => (
            <li key={x.id}>
              <Link href={`/samples/${x.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{x.subject}</p>
                      <p className="mt-0.5 text-xs text-muted">{t("meta", { buyer: x.counterparty.name, quantity: `${x.quantity}${x.unit ? ` ${x.unit}` : ""}`, date: formatDate(x.createdAt, locale) })}</p>
                      {x.status === "requested" ? <p className="mt-0.5 text-xs text-muted">{x.overdue ? t("pastDeadline") : t("replyBy", { date: formatDateTime(x.respondBy, locale) })}</p> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {x.needsMyAction ? <Badge tone="danger">{t("actionNeeded")}</Badge> : null}
                      <Badge tone={TONE[x.status]}>{t(`status.${x.status}`)}</Badge>
                    </div>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
