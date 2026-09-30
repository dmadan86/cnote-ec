import type { ActivityView, MandateChangeView, MandateView, NegotiationSummary, NegotiationView } from "@cnote/a2a";
import { Alert, Badge, Card, CardBody, EmptyState, buttonClasses, type BadgeTone } from "@cnote/ui";
import Link from "next/link";
import { fmt, rupees, type A2aLabels } from "./labels";

// Server-rendered, read-only views. Every string comes from the a2a catalogue; every state is text (never colour alone).
// The views passed in by @cnote/a2a never contain the counterparty's limits, and nothing here asks for them.

export const dateTime = (iso: string, bcp47: string) => new Intl.DateTimeFormat(bcp47, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));

const MANDATE_STATUS: Record<string, [keyof A2aLabels, BadgeTone]> = {
  active: ["mstatusActive", "success"], paused: ["mstatusPaused", "warning"], revoked: ["mstatusRevoked", "neutral"],
  expired: ["mstatusExpired", "neutral"], completed: ["mstatusCompleted", "neutral"], suspended: ["mstatusSuspended", "danger"],
};
export function MandateStatusBadge({ status, t }: { status: string; t: A2aLabels }) {
  const [key, tone] = MANDATE_STATUS[status] ?? ["mstatusActive", "neutral"];
  return <Badge tone={tone}>{t[key]}</Badge>;
}

const NEG_STATUS: Record<string, [keyof A2aLabels, BadgeTone]> = {
  open: ["statusOpen", "brand"], agreed: ["statusAgreed", "warning"], accepted: ["statusAccepted", "success"],
  rejected: ["statusRejected", "neutral"], withdrawn: ["statusWithdrawn", "neutral"], expired: ["statusExpired", "neutral"],
};
export function NegotiationStatusBadge({ status, t }: { status: string; t: A2aLabels }) {
  const [key, tone] = NEG_STATUS[status] ?? ["statusOpen", "neutral"];
  return <Badge tone={tone}>{t[key]}</Badge>;
}

export function DisabledNotice({ t }: { t: A2aLabels }) {
  return <Alert tone="info">{t.disabledNotice}</Alert>;
}

export function TrustLines({ t }: { t: A2aLabels }) {
  return (
    <ul className="flex flex-col gap-1 text-sm text-ink">
      <li className="font-medium">{t.commitNote}</li>
      <li className="text-muted">{t.limitsPrivate}</li>
    </ul>
  );
}

const repeatText = (m: MandateView, t: A2aLabels) => (m.recurrenceDays ? fmt(t.repeatEvery, { n: m.recurrenceDays }) : t.repeatOnce);

export function MandateList({ mandates, t, bcp47 }: { mandates: MandateView[]; t: A2aLabels; bcp47: string }) {
  if (mandates.length === 0) return <EmptyState title={t.mandatesEmpty} />;
  return (
    <ul className="flex flex-col gap-3">
      {mandates.map((m) => (
        <li key={m.id}>
          <Card>
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 text-base font-semibold text-ink">
                  <Link href={`/buyer/agents/mandates/${m.id}`} className="rounded focus-visible:outline-2 focus-visible:outline-brand-600">{m.name}</Link>
                </h3>
                <span className="flex flex-wrap gap-2">
                  <MandateStatusBadge status={m.status} t={t} />
                  <Badge tone={m.autoAccept ? "warning" : "neutral"}>{m.autoAccept ? t.autoOnBadge : t.autoOffBadge}</Badge>
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                {m.title ? <div className="col-span-2 sm:col-span-4"><dt className="sr-only">{t.fTitle}</dt><dd className="text-ink">{m.title}</dd></div> : null}
                <div><dt className="text-xs text-muted">{t.fQuantity}</dt><dd className="text-ink">{fmt(t.qtyUnit, { qty: m.quantity ?? 0, unit: m.unit ?? "" })}</dd></div>
                <div><dt className="text-xs text-muted">{t.lblMax}</dt><dd className="text-ink">{m.limitPricePaise != null ? rupees(m.limitPricePaise) : t.none}</dd></div>
                <div><dt className="text-xs text-muted">{t.lblRepeat}</dt><dd className="text-ink">{repeatText(m, t)}</dd></div>
                <div><dt className="text-xs text-muted">{t.lblNext}</dt><dd className="text-ink">{m.nextRunAt ? dateTime(m.nextRunAt, bcp47) : t.none}</dd></div>
              </dl>
              <div>
                <Link href={`/buyer/agents/mandates/${m.id}`} className={buttonClasses("outline", "md", "min-h-11")}>
                  {t.open}<span className="sr-only">: {m.name}</span>
                </Link>
              </div>
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}

export function ConfirmList({ items, t }: { items: NegotiationSummary[]; t: A2aLabels }) {
  if (items.length === 0) return <p className="text-sm text-muted">{t.confirmEmpty}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((n) => (
        <li key={n.id}>
          <Card className="border-accent-700">
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-sm font-medium text-ink">{fmt(t.confirmItem, { name: n.counterparty.name, price: n.agreedPricePaise != null ? rupees(n.agreedPricePaise) : t.none })}</p>
              <Link href={`/buyer/agents/negotiations/${n.id}`} className={buttonClasses("accent", "md", "min-h-11")}>
                {t.review}<span className="sr-only">: {n.counterparty.name}</span>
              </Link>
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}

const ACTIVITY_KEY: Record<string, keyof A2aLabels> = {
  mandate_created: "actMandateCreated", mandate_updated: "actMandateUpdated", mandate_paused: "actMandatePaused", mandate_resumed: "actMandateResumed",
  mandate_revoked: "actMandateRevoked", mandate_expired: "actMandateExpired", mandate_suspended: "actMandateSuspended", mandate_unsuspended: "actMandateUnsuspended",
  auto_accept_on: "actAutoOn", auto_accept_off: "actAutoOff", negotiation_started: "actStarted", run_started: "actStarted", offer_sent: "actOffer", counter_sent: "actOffer",
  accepted: "actDealReached", rejected: "actRejected", withdrawn: "actWithdrawn", expired: "actExpired", awaiting_confirmation: "actAwaiting",
  confirmed: "actConfirmed", confirmed_auto: "actConfirmed", declined: "actDeclined", quote_sent: "actOrder", order_recorded: "actOrder",
  realise_failed: "actProblem", anomaly_flagged: "actProblem", run_failed: "actProblem", start_skipped: "actProblem",
};

export function ActivityList({ items, t, bcp47 }: { items: ActivityView[]; t: A2aLabels; bcp47: string }) {
  if (items.length === 0) return <p className="text-sm text-muted">{t.activityEmpty}</p>;
  return (
    <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
      {items.map((a) => {
        const label = t[ACTIVITY_KEY[a.action] ?? "actOther"];
        const href = a.negotiationId ? `/buyer/agents/negotiations/${a.negotiationId}` : a.mandateId ? `/buyer/agents/mandates/${a.mandateId}` : null;
        return (
          <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3 text-sm">
            <span className="text-ink">
              {href ? <Link href={href} className="rounded underline focus-visible:outline-2 focus-visible:outline-brand-600">{label}</Link> : label}
              <span className="text-muted"> ({a.byAgent ? t.activityByAgent : t.activityByYou})</span>
            </span>
            <time dateTime={a.createdAt} className="text-xs text-muted">{dateTime(a.createdAt, bcp47)}</time>
          </li>
        );
      })}
    </ol>
  );
}

const CHANGE_KEY: Record<string, keyof A2aLabels> = {
  created: "chgCreated", updated: "chgUpdated", expired: "chgExpired", auto_accept_on: "chgAutoOn", auto_accept_off: "chgAutoOff",
  resumed: "chgResumed", paused: "chgPaused", revoked: "chgRevoked",
};
const BY_KEY: Record<string, keyof A2aLabels> = { human: "byHuman", system: "bySystem", admin: "byAdmin", api: "byApi" };

export function HistoryTable({ changes, t, bcp47 }: { changes: MandateChangeView[]; t: A2aLabels; bcp47: string }) {
  return (
    <div role="region" aria-labelledby="mh-h" tabIndex={0} className="overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-brand-600">
      <table className="w-full min-w-[30rem] border-collapse text-left text-sm">
        <caption className="sr-only">{t.historyCaption}</caption>
        <thead className="bg-canvas text-xs text-muted">
          <tr>
            <th scope="col" className="p-3 font-medium">{t.colWhen}</th>
            <th scope="col" className="p-3 font-medium">{t.colChange}</th>
            <th scope="col" className="p-3 font-medium">{t.colBy}</th>
            <th scope="col" className="p-3 font-medium">{t.colVersion}</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.id} className="border-t border-line align-top">
              <th scope="row" className="p-3 font-normal text-ink"><time dateTime={c.createdAt}>{dateTime(c.createdAt, bcp47)}</time></th>
              <td className="p-3 text-ink">{t[CHANGE_KEY[c.action] ?? "chgUpdated"]}</td>
              <td className="p-3 text-ink">{t[BY_KEY[c.actorKind] ?? "bySystem"]}</td>
              <td className="p-3 text-muted">{c.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TYPE_KEY: Record<string, keyof A2aLabels> = { offer: "typeOffer", counter: "typeCounter", accept: "typeAccept", reject: "typeReject", withdraw: "typeWithdraw" };
const ACTOR_KEY: Record<string, keyof A2aLabels> = { agent: "actorAgent", external_agent: "actorExternal", person: "actorPerson" };

const Dash = ({ t }: { t: A2aLabels }) => (
  <>
    <span aria-hidden="true">-</span>
    <span className="sr-only">{t.noTerms}</span>
  </>
);

/** The typed transcript as a real table: caption, scoped headers, one row per message. Counterparty limits are not in the view and not shown. */
export function Transcript({ n, t, bcp47 }: { n: NegotiationView; t: A2aLabels; bcp47: string }) {
  if (n.messages.length === 0) return <p className="text-sm text-muted">{t.transcriptEmpty}</p>;
  const other = n.youAre === "buyer" ? n.seller.name : n.buyer.name;
  const head = ["colWho", "colType", "colPrice", "colQty", "colUnit", "colLead", "colTerms", "colValid"] as const;
  return (
    <>
      <p className="text-xs text-muted sm:hidden">{t.transcriptCaption}</p>
      <div role="region" aria-label={t.transcriptHeading} tabIndex={0} className="overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-brand-600">
        <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
          <caption className="sr-only">{t.transcriptCaption}</caption>
          <thead className="bg-canvas text-xs text-muted">
            <tr>{head.map((h) => <th key={h} scope="col" className="p-3 font-medium">{t[h]}</th>)}</tr>
          </thead>
          <tbody>
            {n.messages.map((m) => {
              const o = m.offer;
              const terms = o ? [o.deliveryTerms ? fmt(t.termDelivery, { text: o.deliveryTerms }) : null, o.paymentTerms ? fmt(t.termPayment, { text: o.paymentTerms }) : null].filter(Boolean) : [];
              return (
                <tr key={m.seq} className="border-t border-line align-top">
                  <th scope="row" className="p-3 font-medium text-ink">{m.mine ? t.sideYou : other} <span className="font-normal text-muted">({t[ACTOR_KEY[m.actor] ?? "actorAgent"]})</span></th>
                  <td className="p-3 text-ink">{t[TYPE_KEY[m.type] ?? "typeOffer"]}</td>
                  <td className="p-3 text-ink">{o ? rupees(o.pricePaise) : <Dash t={t} />}</td>
                  <td className="p-3 text-ink">{o ? o.quantity.toLocaleString("en-IN") : <Dash t={t} />}</td>
                  <td className="p-3 text-ink">{o ? o.unit : <Dash t={t} />}</td>
                  <td className="p-3 text-ink">{o ? fmt(t.days, { n: o.leadTimeDays }) : <Dash t={t} />}</td>
                  <td className="p-3 text-ink">{terms.length ? terms.map((x) => <span key={x} className="block">{x}</span>) : o ? t.none : <Dash t={t} />}</td>
                  <td className="p-3 text-ink">{o ? <time dateTime={o.validUntil}>{dateTime(o.validUntil, bcp47)}</time> : <Dash t={t} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
