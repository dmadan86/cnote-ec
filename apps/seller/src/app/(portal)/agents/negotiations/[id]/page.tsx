import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, CardHeader, CardTitle, Money, PageHeader, buttonClasses } from "@cnote/ui";
import { actorOf } from "@cnote/next-kit";
import { isA2aEnabled, getNegotiation, listActivity } from "@cnote/a2a";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { ActivityList } from "@/features/a2a/activity-list";
import { NegotiationStatusBadge } from "@/features/a2a/badges";
import { DecisionPanel } from "@/features/a2a/decision-panel";
import { Transcript } from "@/features/a2a/transcript";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("a2a"))("negotiation.metaTitle") };
}

export default async function NegotiationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/agents/negotiations/${id}`);
  const t = await getTranslations("a2a");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const actor = actorOf(session);
  const found = await load(() => getNegotiation(actor, id));
  if (!found.ok) return <div className="space-y-6"><PageHeader title={t("negotiation.title")} /><Alert tone="danger">{found.error}</Alert></div>;
  const n = found.data;
  if (!n || n.youAre !== "seller") notFound();
  const activity = await load(() => listActivity(actor.businessId, { negotiationId: id, limit: 30 }));
  const a = n.agreed;
  return (
    <div className="space-y-8">
      <PageHeader title={t("negotiation.withBuyer", { name: n.buyer.name })} description={t("negotiation.description")} actions={<NegotiationStatusBadge status={n.status} />} />
      <p><Link href="/agents" className="text-sm font-semibold text-brand-700 underline">{t("mandate.back")}</Link></p>
      {!isA2aEnabled() ? <Alert tone="warning">{t("disabled")}</Alert> : null}

      <Card>
        <CardHeader><CardTitle>{t("negotiation.summaryHeading")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">{t("negotiation.roundLabel")}</dt><dd>{t("negotiation.round", { n: n.round, max: n.maxRounds })}</dd></div>
            <div><dt className="text-muted">{t("negotiation.turnLabel")}</dt><dd>{n.turn === null ? t("negotiation.turnNone") : n.turn === "seller" ? t("negotiation.turnYou") : t("negotiation.turnThem")}</dd></div>
            <div><dt className="text-muted">{t("negotiation.expires")}</dt><dd>{formatDateTime(n.expiresAt, locale)}</dd></div>
            <div><dt className="text-muted">{t("negotiation.theirConfirmation")}</dt><dd>{n.counterpartyConfirmed ? t("negotiation.confirmed") : t("negotiation.notYet")}</dd></div>
            <div><dt className="text-muted">{t("negotiation.yourConfirmation")}</dt><dd>{t(`negotiation.conf.${n.yourConfirmation}`)}</dd></div>
            {a ? <div><dt className="text-muted">{t("negotiation.agreedTerms")}</dt><dd><Money paise={a.pricePaise} unit={a.unit} /> · {a.quantity.toLocaleString("en-IN")} {a.unit} · {t("transcript.days", { n: a.leadTimeDays })}</dd></div> : null}
          </dl>
          {n.external ? <p className="text-xs text-muted">{t("negotiation.external")}</p> : null}
          {n.status === "accepted" ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {n.quoteId ? <span>{t("negotiation.quoteRef", { id: n.quoteId.slice(0, 8) })}</span> : null}
              {n.orderId ? <Link href={`/orders/${n.orderId}`} className={buttonClasses("outline", "sm", "min-h-11")}>{t("negotiation.viewOrder")}</Link> : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("decision.heading")}</CardTitle></CardHeader>
        <CardBody><DecisionPanel id={n.id} status={n.status} canConfirm={n.canConfirm} realiseError={n.realiseError} /></CardBody>
      </Card>

      <section aria-labelledby="nt-h" className="space-y-3">
        <h2 id="nt-h" className="text-lg font-bold text-ink">{t("transcript.heading")}</h2>
        <Transcript n={n} />
      </section>

      <section aria-labelledby="na-h" className="space-y-3">
        <h2 id="na-h" className="text-lg font-bold text-ink">{t("overview.activityHeading")}</h2>
        {activity.ok ? <ActivityList items={activity.data} /> : <Alert tone="danger">{activity.error}</Alert>}
      </section>
    </div>
  );
}
