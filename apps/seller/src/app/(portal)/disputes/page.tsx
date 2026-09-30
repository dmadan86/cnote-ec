import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { disputesEnabled, listDisputes } from "@/lib/disputes";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader, Money, type BadgeTone } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("disputes"))("metaTitle") };
}
export const dynamic = "force-dynamic";
const TONE: Record<string, BadgeTone> = { resolved: "success", withdrawn: "neutral", awaiting_adjudication: "warning", auto_resolved: "warning" };
const label = (s: string) => s.replace(/_/g, " ");

export default async function DisputesPage() {
  const session = await requireSeller("/disputes");
  const t = await getTranslations("disputes");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const known = (group: string, v: string) => (t.has(`${group}.${v}`) ? t(`${group}.${v}`) : label(v));
  if (!disputesEnabled()) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="info">{t("notAvailable")}</Alert></div>;
  const res = await load(() => listDisputes(actorOf(session)));
  if (!res.ok) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{res.error}</Alert></div>;
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {res.data.length === 0 ? <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} /> : (
        <ul className="grid gap-3">
          {res.data.map((d) => (
            <li key={d.id}>
              <Link href={`/disputes/${d.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{known("type", d.type)}</p>
                      <p className="mt-0.5 text-xs text-muted">{t("meta", { who: d.openedByMe ? t("openedByYou") : t("reportedByBuyer"), created: formatDate(d.createdAt, locale), due: formatDate(d.dueAt, locale) })}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {d.amountPaise !== null ? <Money paise={d.amountPaise} /> : null}
                      {d.needsMyAction ? <Badge tone="danger">{t("actionNeeded")}</Badge> : null}
                      <Badge tone={TONE[d.status] ?? "brand"}>{known("status", d.status)}</Badge>
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
