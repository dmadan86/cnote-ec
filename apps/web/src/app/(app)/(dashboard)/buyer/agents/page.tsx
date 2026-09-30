import { isA2aEnabled, listActivity, listMandates, listNegotiations } from "@cnote/a2a";
import { requireBusiness } from "@cnote/next-kit";
import { Card, CardBody, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getRequestLocale } from "@/lib/request-locale";
import { loadA2aLabels } from "@/features/a2a/load-labels";
import { MandateForm } from "@/features/a2a/mandate-form";
import { ActivityList, ConfirmList, DisabledNotice, MandateList, TrustLines } from "@/features/a2a/views";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await loadA2aLabels(await getRequestLocale());
  return { title: t.pageTitle };
}

/** ADR-020 buyer agents: mandates, deals waiting for the buyer's confirmation, recent agent activity, and the create form. */
export default async function BuyerAgentsPage() {
  const s = await requireBusiness("/buyer/agents");
  const { t, bcp47 } = await loadA2aLabels(await getRequestLocale());
  const biz = s.business.id;
  const [mandates, waiting, activity] = await Promise.all([
    listMandates(biz, { side: "buyer" }),
    listNegotiations(biz, { side: "buyer", needsConfirmation: true }),
    listActivity(biz, { side: "buyer", limit: 15 }),
  ]);
  return (
    <Container className="max-w-4xl py-8">
      <PageHeader title={t.pageTitle} description={t.pageIntro} />
      <div className="mt-6 flex flex-col gap-8">
        {!isA2aEnabled() ? <DisabledNotice t={t} /> : null}
        <TrustLines t={t} />
        <section aria-labelledby="ag-confirm-h" className="flex flex-col gap-3">
          <h2 id="ag-confirm-h" className="text-lg font-bold text-ink">{t.confirmHeading}</h2>
          <ConfirmList items={waiting} t={t} />
        </section>
        <section aria-labelledby="ag-mandates-h" className="flex flex-col gap-3">
          <h2 id="ag-mandates-h" className="text-lg font-bold text-ink">{t.mandatesHeading}</h2>
          <MandateList mandates={mandates} t={t} bcp47={bcp47} />
        </section>
        <section aria-labelledby="ag-activity-h" className="flex flex-col gap-3">
          <h2 id="ag-activity-h" className="text-lg font-bold text-ink">{t.activityHeading}</h2>
          <ActivityList items={activity} t={t} bcp47={bcp47} />
        </section>
        <Card>
          <CardBody>
            <MandateForm mode="create" t={t} />
          </CardBody>
        </Card>
      </div>
    </Container>
  );
}
