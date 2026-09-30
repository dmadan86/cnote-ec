import { listMyGrievances } from "@cnote/compliance";
import { requireSession } from "@cnote/next-kit";
import { Alert, Badge, buttonClasses, Card, CardBody, Container, EmptyState, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grievance" });
  return { title: t("myTitle") };
}

const TONE = { open: "neutral", in_progress: "brand", resolved: "success", rejected: "warning" } as const;

export default async function MyGrievancesPage() {
  const s = await requireSession("/account/grievances");
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "grievance" });
  const day = (iso: string) => formatDate(iso, locale);
  const items = await listMyGrievances(s.personId).catch((err) => {
    console.error("[grievance] list failed", err);
    return null;
  });
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("myTitle")} description={t("myDescription")} actions={<Link href="/grievance" className={buttonClasses("outline", "md")}>{t("raise")}</Link>} />
      {!items ? (
        <Alert tone="danger">{t("loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((g) => (
            <li key={g.id}>
              <Card>
                <CardBody className="flex flex-col gap-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-base font-semibold text-ink">{g.subject}</h2>
                    <Badge tone={TONE[g.status]}>{t(`status.${g.status}`)}</Badge>
                  </div>
                  <p className="text-muted">
                    {t.rich("filed", { date: day(g.createdAt), id: g.id, code: (c) => <code className="break-all">{c}</code> })}
                    {g.status === "open" || g.status === "in_progress" ? ` · ${t("respondBy", { date: day(g.dueAt) })}` : null}
                  </p>
                  <p className="whitespace-pre-wrap text-ink">{g.body}</p>
                  {g.resolution ? (
                    <div className="rounded-lg border border-line bg-canvas p-3">
                      <p className="font-medium text-ink">{t("officerResponse")}</p>
                      <p className="mt-1 whitespace-pre-wrap">{g.resolution}</p>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
