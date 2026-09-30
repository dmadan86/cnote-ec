import { getNegotiation, isA2aEnabled, listActivity } from "@cnote/a2a";
import { actorOf, currentSession, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fmt, rupees, UUID_RE } from "@/features/a2a/labels";
import { loadA2aLabels } from "@/features/a2a/load-labels";
import { NegotiationActions } from "@/features/a2a/negotiation-controls";
import { ActivityList, DisabledNotice, NegotiationStatusBadge, Transcript, dateTime } from "@/features/a2a/views";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await loadA2aLabels((await currentSession())?.preferredLanguage);
  return { title: t.pageTitle };
}

export default async function NegotiationPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/agents/negotiations/${id}`);
  if (!UUID_RE.test(id)) notFound();
  const { t, bcp47 } = await loadA2aLabels(s.preferredLanguage);
  const actor = actorOf(s);
  const n = await getNegotiation(actor, id);
  if (!n || n.youAre !== "buyer") notFound();
  const activity = await listActivity(actor.businessId, { negotiationId: id, side: "buyer", limit: 15 });
  const canRetry = n.realiseError !== null && n.orderId === null;
  const canWithdraw = n.status === "open";
  const a = n.agreed;
  return (
    <Container className="max-w-4xl py-8">
      <p className="mb-3 text-sm"><Link href="/buyer/agents" className="rounded underline focus-visible:outline-2 focus-visible:outline-brand-600">{t.backToAgents}</Link></p>
      <PageHeader title={fmt(t.negHeading, { name: n.seller.name })} description={`${fmt(t.negRound, { round: n.round, max: n.maxRounds })} · ${fmt(t.negExpires, { when: dateTime(n.expiresAt, bcp47) })}`} />
      <div className="mt-6 flex flex-col gap-8">
        {!isA2aEnabled() ? <DisabledNotice t={t} /> : null}
        <p className="text-base font-semibold text-ink">{t.commitNote}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <span className="font-medium">{t.statusLabel}:</span>
          <NegotiationStatusBadge status={n.status} t={t} />
        </p>

        {a ? (
          <section aria-labelledby="ng-agreed-h" className="flex flex-col gap-3">
            <h2 id="ng-agreed-h" className="text-lg font-bold text-ink">{t.agreedHeading}</h2>
            <Card>
              <CardBody>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-muted">{t.colPrice}</dt><dd className="font-semibold text-ink">{rupees(a.pricePaise)}</dd></div>
                  <div><dt className="text-xs text-muted">{t.colQty}</dt><dd className="text-ink">{fmt(t.qtyUnit, { qty: a.quantity.toLocaleString("en-IN"), unit: a.unit })}</dd></div>
                  <div><dt className="text-xs text-muted">{t.colLead}</dt><dd className="text-ink">{fmt(t.days, { n: a.leadTimeDays })}</dd></div>
                  <div><dt className="text-xs text-muted">{t.colValid}</dt><dd className="text-ink"><time dateTime={a.validUntil}>{dateTime(a.validUntil, bcp47)}</time></dd></div>
                </dl>
              </CardBody>
            </Card>
          </section>
        ) : null}

        {n.status === "agreed" ? (
          <section aria-labelledby="ng-confirm-h" className="flex flex-col gap-3">
            <h2 id="ng-confirm-h" className="text-lg font-bold text-ink">{t.confirmDealHeading}</h2>
            {n.canConfirm ? <p className="text-sm text-ink">{t.confirmDealBody}</p> : null}
            <ul className="text-sm text-ink">
              {n.yourConfirmation !== "pending" ? <li>{t.youConfirmed}</li> : null}
              <li>{n.counterpartyConfirmed ? t.sellerConfirmed : t.sellerPending}</li>
            </ul>
          </section>
        ) : null}

        {n.realiseError !== null ? <Alert tone="warning">{t.realiseFailed}</Alert> : null}
        {n.orderId ? <div><Link href={`/buyer/orders/${n.orderId}`} className={buttonClasses("primary", "md", "min-h-11")}>{t.orderLink}</Link></div> : null}

        <NegotiationActions id={n.id} canConfirm={n.canConfirm} canRetry={canRetry} canWithdraw={canWithdraw} t={t} />

        <section aria-labelledby="ng-transcript-h" className="flex flex-col gap-3">
          <h2 id="ng-transcript-h" className="text-lg font-bold text-ink">{t.transcriptHeading}</h2>
          <Transcript n={n} t={t} bcp47={bcp47} />
        </section>
        <section aria-labelledby="ng-act-h" className="flex flex-col gap-3">
          <h2 id="ng-act-h" className="text-lg font-bold text-ink">{t.activityHeading}</h2>
          <ActivityList items={activity} t={t} bcp47={bcp47} />
        </section>
      </div>
    </Container>
  );
}
