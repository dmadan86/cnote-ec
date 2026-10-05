import { listRateContracts, rateContractsEnabled, type RcStatus } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Badge, Card, CardBody, Container, EmptyState, LinkTabs, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { StatusBadge, day } from "@/features/contracts/views";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "contracts" });
  return { title: t("listMetaTitle") };
}

const FILTERS = ["all", "draft", "proposed", "active", "expired", "terminated"] as const;

export default async function BuyerContractsPage(props: { searchParams: Promise<{ status?: string; cursor?: string }> }) {
  const sp = await props.searchParams;
  const filter = FILTERS.find((f) => f === sp.status) ?? "all";
  const s = await requireBusiness("/buyer/contracts");
  if (!rateContractsEnabled()) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "contracts" });
  const page = await listRateContracts(actorOf(s), { role: "buyer", status: filter === "all" ? null : (filter as RcStatus), cursor: sp.cursor ?? null });
  return (
    <Container className="py-8">
      <PageHeader title={t("listTitle")} description={t("listIntro")} actions={<Link href="/buyer/contracts/new" className={buttonClasses("primary")}>{t("new")}</Link>} />
      <div className="mt-6 flex flex-col gap-5">
        <LinkTabs
          label={t("tabsLabel")}
          linkComponent={Link}
          items={FILTERS.map((f) => ({ href: f === "all" ? "/buyer/contracts" : `/buyer/contracts?status=${f}`, label: t(`tab.${f}`), active: f === filter }))}
        />
        {page.items.length === 0 ? (
          <EmptyState title={t("empty")} description={t("emptyDescription")} action={<Link href="/buyer/contracts/new" className={buttonClasses("outline")}>{t("new")}</Link>} />
        ) : (
          <ul className="flex flex-col gap-3">
            {page.items.map((c) => (
              <li key={c.id}>
                <Link href={`/buyer/contracts/${c.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                  <Card className="transition-colors hover:border-brand-600">
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{c.title}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {c.number} · {c.counterparty.name}
                          {c.validFrom && c.validTo ? ` · ${t("summary.periodValue", { from: day(c.validFrom, locale), to: day(c.validTo, locale) })}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {c.valuePercent !== null ? <span className="text-xs text-muted">{t("valueUsed", { percent: c.valuePercent })}</span> : null}
                        {c.needsAnswer ? <Badge tone="warning">{t("needsAnswer")}</Badge> : null}
                        <StatusBadge status={c.status} locale={locale} />
                      </div>
                    </CardBody>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {page.nextCursor ? (
          <nav aria-label={t("paginationLabel")} className="flex justify-center">
            <Link href={`/buyer/contracts?status=${filter}&cursor=${page.nextCursor}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink">{t("older")}</Link>
          </nav>
        ) : null}
      </div>
    </Container>
  );
}
