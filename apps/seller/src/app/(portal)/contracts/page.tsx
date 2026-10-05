import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { day } from "@/features/purchase-orders/views";
import { RC_TONE, Usage } from "@/features/contracts/views";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("contracts"))("metaTitle") };
}

const TABS = ["answer", "active", "proposals", "ended"] as const;
type Tab = (typeof TABS)[number];

export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if (!enquiry.rateContractsEnabled()) notFound();
  const sp = await searchParams;
  const session = await requireSeller("/contracts");
  const t = await getTranslations("contracts");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const res = await load(() => enquiry.listRateContracts(actorOf(session), { role: "seller", limit: 50 }));
  if (!res.ok) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{res.error}</Alert></div>;
  const rows = res.data.items;
  const match: Record<Tab, (r: (typeof rows)[number]) => boolean> = {
    answer: (r) => r.needsAnswer,
    active: (r) => r.status === "active",
    proposals: (r) => r.status === "proposed",
    ended: (r) => r.status === "expired" || r.status === "terminated",
  };
  const requested = TABS.find((x) => x === sp.tab);
  const tab: Tab = requested ?? (rows.some(match.answer) ? "answer" : "active");
  const shown = rows.filter(match[tab]);
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <nav aria-label={t("tabsLabel")} className="flex flex-wrap gap-2">
        {TABS.map((x) => (
          <Link
            key={x}
            href={`/contracts?tab=${x}`}
            aria-current={x === tab ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium ${x === tab ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line text-ink"}`}
          >
            {t(`tab.${x}`)} <span className="text-xs text-muted">({rows.filter(match[x]).length})</span>
          </Link>
        ))}
      </nav>
      {shown.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t(`empty.${tab}`)} />
      ) : (
        <ul className="grid gap-3">
          {shown.map((r) => (
            <li key={r.id}>
              <Link href={`/contracts/${r.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{r.title}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {r.number} · {r.counterparty.name}
                        {r.validFrom && r.validTo ? ` · ${t("validity", { from: day(r.validFrom, locale), to: day(r.validTo, locale) })}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {r.valuePercent !== null ? <Usage percent={r.valuePercent} label={t("valueUsedLabel", { number: r.number })} /> : null}
                      {r.needsAnswer ? <Badge tone="warning">{t("needsAnswer")}</Badge> : null}
                      <Badge tone={RC_TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
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
