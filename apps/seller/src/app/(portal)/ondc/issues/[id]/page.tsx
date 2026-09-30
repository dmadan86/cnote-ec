import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader, buttonClasses } from "@cnote/ui";
import { getSellerIssue } from "@/lib/ondc";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { IssueCategory, IssueStatusBadge } from "../status";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("ondc.issues"))("detailMetaTitle") };
}

const RESOLUTION = ["REFUND", "REPLACEMENT", "NO-ACTION", "RESOLVE-PROCESS"];

export default async function OndcIssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/ondc/issues/${id}`);
  const t = await getTranslations("ondc.issues");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const res = await load(() => getSellerIssue(session.business.id, id));
  const back = (
    <Link href="/ondc/issues" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700">
      <ArrowLeft className="size-4" aria-hidden /> {t("back")}
    </Link>
  );
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const i = res.data;
  if (!i) return <div className="space-y-4">{back}<Alert tone="warning">{t("notFound")}</Alert></div>;
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={<IssueCategory category={i.category} />} description={t("raised", { date: formatDateTime(i.createdAt, locale), bap: i.bapId })} actions={<IssueStatusBadge status={i.status} />} />
      {i.overdue ? <Alert tone="warning">{t("overdue")}</Alert> : null}
      <Card>
        <CardHeader><CardTitle>{t("whatBuyerSaid")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="whitespace-pre-line text-sm text-ink">{i.description}</p>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row k={t("categoryLabel")} v={<><IssueCategory category={i.category} />{i.subCategory ? ` (${i.subCategory})` : ""}</>} />
            <Row k={t("statusLabel")} v={<IssueStatusBadge status={i.status} />} />
            <Row k={t("reference")} v={<span className="break-all">{i.issueId}</span>} />
            {i.ondcOrderId ? <Row k={t("linkedOrder")} v={<Link href="/ondc/orders" className="font-medium text-brand-700 underline">{i.ondcOrderId.slice(0, 8)}</Link>} /> : null}
          </dl>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("deadlines")}</CardTitle></CardHeader>
        <CardBody>
          <ul className="space-y-1 text-sm text-ink">
            <li>{t("respondBy", { when: formatDateTime(i.expectedResponseAt, locale) })}</li>
            <li>{t("resolveBy", { when: formatDateTime(i.expectedResolutionAt, locale) })}</li>
            {i.cascadedAt ? <li>{t("cascaded", { when: formatDateTime(i.cascadedAt, locale) })}</li> : null}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("resolution")}</CardTitle></CardHeader>
        <CardBody className="space-y-2 text-sm">
          {i.resolution ? (
            <>
              <p><Badge tone="success">{RESOLUTION.includes(i.resolution.action) ? t(`resolutionAction.${i.resolution.action}` as "resolutionAction.REFUND") : i.resolution.action}</Badge></p>
              {i.resolution.refundAmount ? <p className="text-ink">{t("refundAmount", { amount: i.resolution.refundAmount })}</p> : null}
              <p className="text-ink">{i.resolution.shortDesc}</p>
            </>
          ) : <p className="text-muted">{t("noResolution")}</p>}
          {i.disputeId ? (
            <div className="space-y-2 pt-2">
              <p className="text-muted">{t("disputeHelp")}</p>
              <Link href={`/disputes/${i.disputeId}`} className={buttonClasses("primary", "md", "min-h-11")}>{t("viewDispute")}</Link>
            </div>
          ) : <p className="pt-2 text-muted">{t("noDispute")}</p>}
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}
