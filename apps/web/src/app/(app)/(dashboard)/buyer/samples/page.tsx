import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, Container, EmptyState, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { listBuyerSamples, samplesEnabled } from "@/lib/samples";
import { fill, sampleLabels } from "@/features/samples/labels";
import { SampleStatusBadge } from "@/features/samples/view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("samples") };
}

const FILTERS = ["all", "open", "done"] as const;

export default async function BuyerSamplesPage(props: { searchParams: Promise<{ filter?: string }> }) {
  const { filter: raw } = await props.searchParams;
  const filter = (FILTERS as readonly string[]).includes(raw ?? "") ? (raw as (typeof FILTERS)[number]) : "all";
  const s = await requireBusiness("/buyer/samples");
  const locale = await getRequestLocale();
  const l = await sampleLabels(locale);
  if (!samplesEnabled()) {
    return <Container className="py-8"><PageHeader title={l.title} /><Alert tone="info" className="mt-6">{l.notAvailable}</Alert></Container>;
  }
  const items = await listBuyerSamples(actorOf(s), { filter: filter === "all" ? undefined : filter });
  const tabLabel = { all: l.filterAll, open: l.filterOpen, done: l.filterDone };
  return (
    <Container className="py-8">
      <PageHeader title={l.title} description={l.intro} />
      <nav aria-label={l.filterLabel} className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/buyer/samples" : `/buyer/samples?filter=${f}`}
            aria-current={f === filter ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600 ${f === filter ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line bg-surface text-ink"}`}
          >
            {tabLabel[f]}
          </Link>
        ))}
      </nav>
      <div className="mt-4">
        {items.length === 0 ? (
          <EmptyState title={l.emptyTitle} description={l.emptyDesc} />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((x) => (
              <li key={x.id}>
                <Link href={`/buyer/samples/${x.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                  <Card className="transition-colors hover:border-brand-600">
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{x.subject}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {x.counterparty.name} · {l.quantity}: {x.quantity}{x.unit ? ` ${x.unit}` : ""} · {formatDate(x.createdAt, locale, { day: "numeric", month: "short", year: "numeric" })}
                        </p>
                        {x.status === "requested" ? <p className="mt-0.5 text-xs text-muted">{fill(l.waitingSupplier, { date: formatDate(x.respondBy, locale, { dateStyle: "medium", timeStyle: "short" }) })}</p> : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {x.needsMyAction ? <Badge tone="danger">{l.needsAction}</Badge> : null}
                        <SampleStatusBadge status={x.status} labels={l} />
                      </div>
                    </CardBody>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Container>
  );
}
