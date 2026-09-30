import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, buttonClasses } from "@cnote/ui";
import { isA2aEnabled, listActivity, listMandates, listNegotiations } from "@cnote/a2a";
import { listPriceBook } from "@cnote/negotiation";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { ActivityList } from "@/features/a2a/activity-list";
import { MandateList, NegotiationList } from "@/features/a2a/lists";
import { MandateForm } from "@/features/a2a/mandate-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("a2a"))("overview.metaTitle") };
}

/** ADR-020 seller agent hub: quoting mandates, deals waiting for your confirmation, and what your agent did. */
export default async function AgentsPage() {
  const session = await requireSeller("/agents");
  const t = await getTranslations("a2a");
  const id = session.business.id;
  const [mandates, waiting, recent, activity, book] = await Promise.all([
    load(() => listMandates(id, { side: "seller" })),
    load(() => listNegotiations(id, { side: "seller", needsConfirmation: true })),
    load(() => listNegotiations(id, { side: "seller", limit: 20 })),
    load(() => listActivity(id, { side: "seller", limit: 20 })),
    load(() => listPriceBook(id)),
  ]);
  const options = book.ok ? book.data.filter((b) => b.active).map((b) => ({ id: b.id, title: b.title })) : [];
  return (
    <div className="space-y-8">
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      {!isA2aEnabled() ? <Alert tone="warning">{t("disabled")}</Alert> : null}
      <Alert tone="info">{t("controlNotice")}</Alert>

      <section aria-labelledby="ag-wait-h" className="space-y-3">
        <h2 id="ag-wait-h" className="text-lg font-bold text-ink">{t("overview.waitingHeading")}</h2>
        {waiting.ok ? <NegotiationList items={waiting.data} empty={t("overview.waitingEmpty")} /> : <Alert tone="danger">{waiting.error}</Alert>}
      </section>

      <section aria-labelledby="ag-man-h" className="space-y-3">
        <h2 id="ag-man-h" className="text-lg font-bold text-ink">{t("overview.mandatesHeading")}</h2>
        {!mandates.ok ? <Alert tone="danger">{mandates.error}</Alert> : mandates.data.length === 0 ? (
          <EmptyState title={t("overview.mandatesEmptyTitle")} description={t("overview.mandatesEmptyDescription")} />
        ) : <MandateList items={mandates.data} />}
      </section>

      <Card>
        <CardHeader><CardTitle>{t("overview.createHeading")}</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          {options.length === 0 ? (
            <Alert tone="warning">
              {t("overview.needPriceBook")}{" "}
              <Link href="/price-book" className={buttonClasses("outline", "sm", "ml-2 min-h-11")}>{t("overview.openPriceBook")}</Link>
            </Alert>
          ) : null}
          <MandateForm mode="create" priceBook={options} />
        </CardBody>
      </Card>

      <section aria-labelledby="ag-neg-h" className="space-y-3">
        <h2 id="ag-neg-h" className="text-lg font-bold text-ink">{t("overview.negotiationsHeading")}</h2>
        {recent.ok ? <NegotiationList items={recent.data} empty={t("overview.negotiationsEmpty")} /> : <Alert tone="danger">{recent.error}</Alert>}
      </section>

      <section aria-labelledby="ag-act-h" className="space-y-3">
        <h2 id="ag-act-h" className="text-lg font-bold text-ink">{t("overview.activityHeading")}</h2>
        {activity.ok ? <ActivityList items={activity.data} /> : <Alert tone="danger">{activity.error}</Alert>}
      </section>
    </div>
  );
}
