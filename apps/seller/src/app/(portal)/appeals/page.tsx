import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { describeSubject, listMyAppeals, type AppealView } from "@cnote/compliance";
import { Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("appeals");
  return { title: t("meta") };
}

const STATUS = {
  open: { tone: "neutral", key: "review" },
  in_progress: { tone: "neutral", key: "review" },
  resolved: { tone: "success", key: "upheld" },
  rejected: { tone: "danger", key: "stands" },
} as const;
const TYPE_KEYS = ["listing_version", "listing_image", "review", "comment", "storefront_version"];

async function withTitles(appeals: AppealView[]) {
  return Promise.all(appeals.map(async (a) => ({ a, title: (await describeSubject(a.subjectType, a.subjectId).catch(() => null))?.title ?? null })));
}

export default async function AppealsPage() {
  const session = await requireSeller("/appeals");
  const t = await getTranslations("appeals");
  const f = await getFormatter();
  const typeLabel = (type: string) => (TYPE_KEYS.includes(type) ? t(`types.${type}`) : type);
  const res = await load(async () => withTitles(await listMyAppeals(session.personId)));
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {!res.ok ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.description")} />
      ) : res.data.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.description")} />
      ) : (
        <ul className="space-y-4">
          {res.data.map(({ a, title }) => (
            <li key={a.id}>
              <Card>
                <CardBody className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-base font-semibold text-ink">{title ?? typeLabel(a.subjectType)}</h2>
                    <Badge tone={STATUS[a.status].tone}>{t(`status.${STATUS[a.status].key}`)}</Badge>
                  </div>
                  <p className="text-muted">{t("appealedOn", { type: typeLabel(a.subjectType), date: f.dateTime(new Date(a.createdAt), { dateStyle: "medium" }) })}</p>
                  <p className="whitespace-pre-wrap text-ink">{a.reason}</p>
                  {a.decisionNote ? (
                    <div className="rounded-lg border border-line bg-canvas p-3">
                      <p className="font-medium text-ink">{t("response")}</p>
                      <p className="mt-1 whitespace-pre-wrap">{a.decisionNote.replace(/\n\[follow-up\].*$/s, "")}</p>
                      {a.needsFollowUp ? <p className="mt-2 text-muted">{t("followUp")}</p> : null}
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
