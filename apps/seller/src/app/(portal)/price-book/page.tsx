import type { Metadata } from "next";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader } from "@cnote/ui";
import { isQuoteAssistEnabled, listPriceBook, listAgentActions } from "@cnote/negotiation";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { PriceBookForm, type PriceBookRow } from "@/features/negotiation/price-book-form";
import { AssistantLog } from "@/features/negotiation/assistant-log";

export const metadata: Metadata = { title: "Price book" };

export default async function PriceBookPage() {
  const session = await requireSeller("/price-book");
  const id = session.business.id;
  const [book, log] = await Promise.all([load(() => listPriceBook(id)), load(() => listAgentActions(id, { role: "seller", limit: 20 }))]);
  const on = isQuoteAssistEnabled();
  return (
    <div className="space-y-8">
      <PageHeader title="Price book" description="Your prices, price breaks and lowest acceptable price per product. The quote assistant drafts from this, and you approve every quote before it is sent." />
      <Alert tone="info">
        <strong>You stay in control.</strong> The assistant only drafts. Nothing reaches a buyer until you approve it, and it can never quote below your lowest price. That price is private and is never shown to buyers.
        {on ? "" : " The assistant is not switched on for your account yet, but you can prepare your price book now."}
      </Alert>
      {!book.ok ? <Alert tone="danger">{book.error}</Alert> : book.data.length === 0 ? (
        <EmptyState title="No priced products yet" description="Publish a listing with a price and it appears here, ready to edit." />
      ) : (
        <div className="space-y-6">
          {book.data.map((b) => (
            <Card key={b.id}>
              <CardHeader>
                <CardTitle>{b.title}</CardTitle>
                <span className="flex gap-2">
                  {b.seeded ? <Badge tone="warning">Copied from your listing: review it</Badge> : <Badge tone="success">Set by you</Badge>}
                  {!b.active ? <Badge tone="neutral">Assistant off</Badge> : null}
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
        <h2 id="assistant-log-h" className="text-lg font-bold text-ink">What the assistant did</h2>
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
