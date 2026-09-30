import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader, buttonClasses } from "@cnote/ui";
import { listSellerIssues } from "@/lib/ondc";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate, formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { IssueCategory, IssueStatusBadge } from "./status";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("ondc.issues"))("metaTitle") };
}

export default async function OndcIssuesPage() {
  const session = await requireSeller("/ondc/issues");
  const t = await getTranslations("ondc.issues");
  const tOndc = await getTranslations("ondc");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const res = await load(() => listSellerIssues(session.business.id));
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} actions={<Link href="/ondc" className={buttonClasses("outline", "md", "min-h-11")}>{tOndc("title")}</Link>} />
      {!res.ok ? <Alert tone="danger">{res.error}</Alert> : res.data.length === 0 ? <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} /> : (
        <ul className="grid gap-3">
          {res.data.map((i) => (
            <li key={i.id}>
              <Card><CardBody className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink"><IssueCategory category={i.category} /></p>
                    <p className="mt-0.5 text-xs text-muted">{t("raised", { date: formatDate(i.createdAt, locale), bap: i.bapId })}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <IssueStatusBadge status={i.status} />
                    {i.overdue ? <Badge tone="danger">{t("overdue")}</Badge> : null}
                    {i.needsManual ? <Badge tone="neutral">{t("needsManual")}</Badge> : null}
                  </div>
                </div>
                <p className="line-clamp-2 text-sm text-ink">{i.description}</p>
                <p className="text-xs text-muted">{t("resolveBy", { when: formatDateTime(i.expectedResolutionAt, locale) })}</p>
                <Link href={`/ondc/issues/${i.id}`} className={buttonClasses("outline", "md", "min-h-11")}>{t("viewDetails")}</Link>
              </CardBody></Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
