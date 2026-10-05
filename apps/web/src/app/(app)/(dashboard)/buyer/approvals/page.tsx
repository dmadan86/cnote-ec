import { listPending, listRequests, type RequestView } from "@cnote/approvals";
import { can, getMemberRole } from "@cnote/identity";
import { requireBusiness } from "@cnote/next-kit";
import { Badge, Card, CardBody, Container, EmptyState, LinkTabs, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { personNames, rupees, STATUS_TONE } from "@/features/approvals/trail";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "approvals" });
  return { title: t("inbox.title") };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ApprovalInboxPage(props: PageProps<"/buyer/approvals">) {
  const s = await requireBusiness("/buyer/approvals");
  const role = await getMemberRole(s.personId, s.business.id);
  if (!role) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "approvals" });
  const sp = await props.searchParams;
  const manager = can(role, "policy.manage") || can(role, "spend.manage");
  const tabs = [{ key: "waiting", label: t("inbox.tabWaiting") }, { key: "mine", label: t("inbox.tabMine") }, ...(manager ? [{ key: "all", label: t("inbox.tabAll") }] : [])];
  const requested = first(sp.tab);
  const tab = tabs.some((x) => x.key === requested) ? (requested as string) : "waiting";

  const rows: (RequestView & { onBehalfOfPersonId?: string | null })[] =
    tab === "waiting" ? await listPending({ businessId: s.business.id, personId: s.personId }) : await listRequests({ businessId: s.business.id, personId: s.personId, scope: tab === "all" ? "all" : "mine" });
  const names = await personNames(rows.flatMap((r) => [r.requesterPersonId, r.onBehalfOfPersonId]));
  const when = (iso: string) => formatDate(iso, locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("inbox.title")}
        description={t("inbox.description")}
        actions={manager ? <Link href="/account/approvals" className={buttonClasses("outline")}>{t("rules.title")}</Link> : undefined}
      />
      <LinkTabs label={t("inbox.tabsLabel")} items={tabs.map((x) => ({ href: `/buyer/approvals?tab=${x.key}`, label: x.label, active: x.key === tab }))} linkComponent={Link} />
      {rows.length === 0 ? (
        <EmptyState title={t(`inbox.empty.${tab}.title`)} description={t(`inbox.empty.${tab}.body`)} />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/buyer/approvals/${r.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 font-semibold text-ink">{r.subject.summary}</p>
                      <Badge tone={STATUS_TONE[r.status]}><span className="sr-only">{t("inbox.statusLabel")}: </span>{t(`status.${r.status}`)}</Badge>
                    </div>
                    <p className="text-sm text-muted">
                      {t(`actions.${r.action}`)} · {rupees(r.amountPaise)} · {t("inbox.by", { name: names.get(r.requesterPersonId) ?? "—" })} · {when(r.createdAt)}
                    </p>
                    {r.status === "pending" ? <p className="text-sm text-ink">{t("inbox.step", { n: r.currentLevel, total: r.totalLevels })}{r.onBehalfOfPersonId ? ` · ${t("inbox.onBehalf", { name: names.get(r.onBehalfOfPersonId) ?? "—" })}` : ""}</p> : null}
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
