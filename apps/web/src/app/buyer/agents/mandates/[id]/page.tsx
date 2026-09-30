import { getMandate, listActivity, listMandateChanges, isA2aEnabled } from "@cnote/a2a";
import { actorOf, currentSession, requireBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoAcceptControl, MandateStatusControls } from "@/features/a2a/mandate-controls";
import { MandateForm, type MandateDefaults } from "@/features/a2a/mandate-form";
import { fmt, paiseToInput, rupees, UUID_RE } from "@/features/a2a/labels";
import { loadA2aLabels } from "@/features/a2a/load-labels";
import { ActivityList, DisabledNotice, HistoryTable, MandateStatusBadge, TrustLines, dateTime } from "@/features/a2a/views";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await loadA2aLabels((await currentSession())?.preferredLanguage);
  return { title: t.pageTitle };
}

const istDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));

export default async function MandatePage(props: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  const { id } = await props.params;
  const { done } = await props.searchParams;
  const s = await requireBusiness(`/buyer/agents/mandates/${id}`);
  if (!UUID_RE.test(id)) notFound();
  const { t, bcp47 } = await loadA2aLabels(s.preferredLanguage);
  const actor = actorOf(s);
  const m = await getMandate(actor.businessId, id);
  if (!m || m.side !== "buyer") notFound();
  const [changes, activity] = await Promise.all([listMandateChanges(actor.businessId, id), listActivity(actor.businessId, { mandateId: id, limit: 15 })]);
  const editable = m.status === "active" || m.status === "paused";
  const defaults: MandateDefaults = {
    id: m.id, name: m.name, title: m.title ?? "", requirement: m.requirement ?? "", categorySlug: m.categorySlug ?? "", quantity: String(m.quantity ?? ""), unit: m.unit ?? "",
    target: paiseToInput(m.targetPricePaise), max: paiseToInput(m.limitPricePaise), lead: m.maxLeadTimeDays ? String(m.maxLeadTimeDays) : "",
    sellers: m.approvedSellerIds.join("\n"), recurDays: m.recurrenceDays, expiry: m.expiresAt ? istDate(m.expiresAt) : "",
  };
  return (
    <Container className="max-w-4xl py-8">
      <p className="mb-3 text-sm"><Link href="/buyer/agents" className="rounded underline focus-visible:outline-2 focus-visible:outline-brand-600">{t.backToAgents}</Link></p>
      <PageHeader title={m.name} description={m.title ?? undefined} actions={<MandateStatusBadge status={m.status} t={t} />} />
      <div className="mt-6 flex flex-col gap-8">
        {done === "created" ? <Alert tone="success">{t.created}</Alert> : null}
        {!isA2aEnabled() ? <DisabledNotice t={t} /> : null}
        <TrustLines t={t} />
        <Card>
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-muted">{t.fQuantity}</dt><dd className="text-ink">{fmt(t.qtyUnit, { qty: m.quantity ?? 0, unit: m.unit ?? "" })}</dd></div>
              <div><dt className="text-xs text-muted">{t.fTarget}</dt><dd className="text-ink">{m.targetPricePaise != null ? rupees(m.targetPricePaise) : t.none}</dd></div>
              <div><dt className="text-xs text-muted">{t.lblMax}</dt><dd className="text-ink">{m.limitPricePaise != null ? rupees(m.limitPricePaise) : t.none}</dd></div>
              <div><dt className="text-xs text-muted">{t.lblRepeat}</dt><dd className="text-ink">{m.recurrenceDays ? fmt(t.repeatEvery, { n: m.recurrenceDays }) : t.repeatOnce}</dd></div>
              <div><dt className="text-xs text-muted">{t.lblNext}</dt><dd className="text-ink">{m.nextRunAt ? dateTime(m.nextRunAt, bcp47) : t.none}</dd></div>
              <div><dt className="text-xs text-muted">{t.fExpiry}</dt><dd className="text-ink">{m.expiresAt ? dateTime(m.expiresAt, bcp47) : t.none}</dd></div>
              <div><dt className="text-xs text-muted">{t.autoHeading}</dt><dd><Badge tone={m.autoAccept ? "warning" : "neutral"}>{m.autoAccept ? t.autoOnBadge : t.autoOffBadge}</Badge></dd></div>
            </dl>
          </CardBody>
        </Card>
        <MandateStatusControls id={m.id} status={m.status} t={t} />
        <AutoAcceptControl
          id={m.id}
          enabled={m.autoAccept}
          limitLabel={m.autoAcceptLimitPaise != null ? rupees(m.autoAcceptLimitPaise) : null}
          maxHint={m.limitPricePaise != null ? `${t.lblMax}: ${rupees(m.limitPricePaise)}` : null}
          canChange={editable}
          t={t}
        />
        {editable ? (
          <Card><CardBody><MandateForm mode="edit" t={t} defaults={defaults} /></CardBody></Card>
        ) : (
          <Alert tone="info">{t.readOnly}</Alert>
        )}
        <section aria-labelledby="ma-act-h" className="flex flex-col gap-3">
          <h2 id="ma-act-h" className="text-lg font-bold text-ink">{t.mandateActivity}</h2>
          <ActivityList items={activity} t={t} bcp47={bcp47} />
        </section>
        <section className="flex flex-col gap-3">
          <h2 id="mh-h" className="text-lg font-bold text-ink">{t.historyHeading}</h2>
          <HistoryTable changes={changes} t={t} bcp47={bcp47} />
        </section>
        <div><Link href="/buyer/agents" className={buttonClasses("outline", "md", "min-h-11")}>{t.backToAgents}</Link></div>
      </div>
    </Container>
  );
}
