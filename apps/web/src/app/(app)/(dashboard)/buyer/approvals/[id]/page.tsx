import { getRequest, listPending } from "@cnote/approvals";
import { can, getMemberRole } from "@cnote/identity";
import { requireBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CancelRequestForm, DecisionForm } from "@/features/approvals/forms";
import { ApprovalTrail, personNames, rupees, STATUS_TONE } from "@/features/approvals/trail";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "approvals" });
  return { title: t("detail.title") };
}

const SUBJECT_HREF: Record<string, (id: string) => string | null> = {
  enquiry: (id) => `/buyer/enquiries/${id}`,
  quote: () => null,
};

export default async function ApprovalDetailPage(props: PageProps<"/buyer/approvals/[id]">) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/approvals/${id}`);
  const role = await getMemberRole(s.personId, s.business.id);
  if (!role) notFound();
  const r = await getRequest(s.business.id, id);
  if (!r) notFound();
  // visible to the requester, whoever can decide it, and managers
  const mayDecide = r.status === "pending" && (await listPending({ businessId: s.business.id, personId: s.personId })).some((x) => x.id === r.id);
  const mine = r.requesterPersonId === s.personId;
  const manager = can(role, "policy.manage") || can(role, "spend.manage");
  if (!mine && !mayDecide && !manager && !r.decisions.some((d) => d.deciderPersonId === s.personId)) notFound();

  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "approvals" });
  const names = await personNames([r.requesterPersonId, ...r.approverPersonIds]);
  const href = SUBJECT_HREF[r.subject.type]?.(r.subject.id) ?? null;

  return (
    <Container className="flex max-w-3xl flex-col gap-6 py-8">
      <PageHeader title={r.subject.summary} description={t(`actions.${r.action}`)} actions={<Badge tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Badge>} />
      <Card>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row k={t("detail.amount")} v={rupees(r.amountPaise)} />
            <Row k={t("detail.requestedBy")} v={names.get(r.requesterPersonId) ?? "—"} />
            <Row k={t("detail.requestedOn")} v={formatDate(r.createdAt, locale, { dateStyle: "medium", timeStyle: "short" })} />
            {r.status === "pending" ? <Row k={t("detail.step")} v={t("inbox.step", { n: r.currentLevel, total: r.totalLevels })} /> : null}
            {r.status === "pending" ? <Row k={t("detail.waitingOn")} v={r.approverPersonIds.map((p) => names.get(p) ?? "—").join(", ") || "—"} /> : null}
            {r.status === "pending" ? <Row k={t("detail.due")} v={formatDate(r.dueAt, locale, { dateStyle: "medium", timeStyle: "short" })} /> : null}
          </dl>
          {r.reason === "spend_limit" ? <Alert tone="warning" className="mt-4">{t("detail.overLimit")}</Alert> : null}
          {href ? <Link href={href} className={buttonClasses("outline", "md", "mt-4")}>{t("detail.openSubject")}</Link> : null}
        </CardBody>
      </Card>

      {mayDecide ? (
        <Card>
          <CardHeader><CardTitle>{t("decide.title")}</CardTitle></CardHeader>
          <CardBody><DecisionForm requestId={r.id} /></CardBody>
        </Card>
      ) : r.status === "pending" && mine ? (
        <Card>
          <CardHeader><CardTitle>{t("decide.waitingTitle")}</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-3"><p className="text-sm text-muted">{t("decide.waitingBody")}</p><CancelRequestForm requestId={r.id} /></CardBody>
        </Card>
      ) : null}

      <ApprovalTrail requests={[r]} locale={locale} />
      <Link href="/buyer/approvals" className="text-sm text-brand-700 underline">{t("detail.back")}</Link>
    </Container>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-ink">{v}</dd>
    </div>
  );
}
