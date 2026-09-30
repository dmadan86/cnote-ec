import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader } from "@cnote/ui";
import { isQuoteAssistEnabled, listPriceBook, listAgentActions } from "@cnote/negotiation";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { PriceBookForm, type PriceBookRow } from "@/features/negotiation/price-book-form";
import { AssistantLog } from "@/features/negotiation/assistant-log";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("negotiation.priceBook"))("metaTitle") };
}

export default async function PriceBookPage() {
  const session = await requireSeller("/price-book");
  const t = await getTranslations("negotiation.priceBook");
  const id = session.business.id;
  const [book, log] = await Promise.all([load(() => listPriceBook(id)), load(() => listAgentActions(id, { role: "seller", limit: 20 }))]);
  const on = isQuoteAssistEnabled();
  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      <Alert tone="info">
        {t.rich("controlNotice", { b: (c) => <strong>{c}</strong> })}
        {on ? "" : ` ${t("notOn")}`}
      </Alert>
      {!book.ok ? <Alert tone="danger">{book.error}</Alert> : book.data.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <div className="space-y-6">
          {book.data.map((b) => (
            <Card key={b.id}>
              <CardHeader>
                <CardTitle>{b.title}</CardTitle>
                <span className="flex gap-2">
                  {b.seeded ? <Badge tone="warning">{t("seeded")}</Badge> : <Badge tone="success">{t("setByYou")}</Badge>}
                  {!b.active ? <Badge tone="neutral">{t("assistantOff")}</Badge> : null}
                </span>
              </CardHeader>
              <CardBody>
                <PriceBookForm row={toRow(b)} />
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <section aria-labelledby="assistant-log-h" className="space-y-3">
        <h2 id="assistant-log-h" className="text-lg font-bold text-ink">{t("logHeading")}</h2>
        {log.ok ? <AssistantLog actions={log.data} /> : <Alert tone="danger">{log.error}</Alert>}
      </section>
    </div>
  );
}

function toRow(b: Awaited<ReturnType<typeof listPriceBook>>[number]): PriceBookRow {
  return {
    listingId: b.listingId, title: b.title, unit: b.unit, baseRupees: b.basePricePaise / 100, floorRupees: b.floorPricePaise / 100,
    tiers: b.tiers.map((t) => ({ minQty: t.minQty, rupees: t.pricePaise / 100 })), moq: b.moq, leadTimeDays: b.leadTimeDays, deliveryTerms: b.deliveryTerms,
    gstPercent: b.gstPercent, gstIncluded: b.gstIncluded, validityDays: b.validityDays, active: b.active, seeded: b.seeded,
  };
}
