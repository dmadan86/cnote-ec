import type { Actor } from "@cnote/enquiry";
import { compareQuotes, getBuyerBounds, isQuoteAssistEnabled, listAgentActions, type AgentActionView, type ComparisonRow } from "@cnote/negotiation";
import { Alert, Badge, Card, CardBody, TrustBadge } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/config";
import { BoundsForm } from "./bounds-form";
import { CounterEditor, SuggestCounter } from "./counter-controls";
import { fmt, inr, NEGOTIATION_KEYS, type NegotiationLabels } from "./labels";

/**
 * ADR-014 buyer comparison + counter assist. Mount on the buyer enquiry page:
 *   <NegotiationAssist enquiryId={e.id} actor={actorOf(s)} locale={s.preferredLanguage} />
 * Renders nothing while QUOTE_ASSIST_ENABLED is off. Text badges (not colour alone), a real <table> with a caption and scoped headers,
 * a keyboard-focusable scroll region on small screens, 44px targets, and polite live regions for results.
 */
export async function NegotiationAssist({ enquiryId, actor, locale: given }: { enquiryId: string; actor: Actor; locale?: string }) {
  if (!isQuoteAssistEnabled()) return null;
  const locale: Locale = given && isLocale(given) ? given : "en";
  const tr = await getTranslations({ locale, namespace: "negotiation" });
  const t = Object.fromEntries(NEGOTIATION_KEYS.map((k) => [k, tr.raw(k) as string])) as NegotiationLabels;

  let cmp, log: AgentActionView[];
  try {
    cmp = await compareQuotes(actor, enquiryId);
    log = await listAgentActions(actor.businessId, { enquiryId, role: "buyer", limit: 15 });
  } catch (err) {
    console.error("[web] negotiation assist failed to load", err);
    return <Alert tone="warning">{t.error}</Alert>;
  }
  const bounds = await getBuyerBounds(actor, enquiryId);
  const unit = cmp.unit ?? "unit";

  return (
    <section aria-labelledby="neg-h" className="flex flex-col gap-4">
      <div>
        <h2 id="neg-h" className="text-lg font-bold text-ink">{t.heading}</h2>
        <p className="mt-1 text-sm text-muted">{t.intro}</p>
      </div>

      {cmp.rows.length === 0 ? <Alert tone="info">{t.noQuotes}</Alert> : (
        <>
          {cmp.needsReview ? <Alert tone="warning">{t.reviewNote}</Alert> : null}
          <p className="text-xs text-muted sm:hidden">{t.scrollHint}</p>
          <div role="region" aria-label={t.regionLabel} tabIndex={0} className="overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-brand-600">
            <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
              <caption className="sr-only">{t.tableCaption}</caption>
              <thead className="bg-canvas text-xs text-muted">
                <tr>
                  <th scope="col" className="p-3 font-medium">{t.colSeller}</th>
                  <th scope="col" className="p-3 font-medium">{fmt(t.colQuoted, { unit })}</th>
                  <th scope="col" className="p-3 font-medium">{t.colDelivery}</th>
                  <th scope="col" className="p-3 font-medium">{t.colGst}</th>
                  <th scope="col" className="p-3 font-medium">{t.colLanded}</th>
                  <th scope="col" className="p-3 font-medium">{t.colQty}</th>
                  <th scope="col" className="p-3 font-medium">{t.colLead}</th>
                  <th scope="col" className="p-3 font-medium">{t.colValid}</th>
                </tr>
              </thead>
              <tbody>
                {cmp.rows.map((r) => (
                  <tr key={r.quoteId} className="border-t border-line align-top">
                    <th scope="row" className="p-3 font-semibold text-ink">
                      <span className="block">{r.sellerName}</span>
                      <span className="mt-1 flex flex-wrap gap-1 font-normal">
                        <TrustBadge tier={r.verificationTier} badgeActive={r.badgeActive} />
                        {r.badges.includes("best_value") ? <Badge tone="success">{t.badgeBestValue}</Badge> : null}
                        {r.badges.includes("best_price") ? <Badge tone="brand">{t.badgeLowest}</Badge> : null}
                        {r.badges.includes("fastest") ? <Badge tone="accent">{t.badgeFastest}</Badge> : null}
                      </span>
                      {r.earlierQuotes > 0 ? <span className="mt-1 block text-xs font-normal text-muted">{fmt(t.earlier, { n: r.earlierQuotes })}</span> : null}
                    </th>
                    <td className="p-3">{inr(r.pricePaise)}</td>
                    <td className="p-3">{delivery(r, t)}</td>
                    <td className="p-3">{gst(r, t)}</td>
                    <td className="p-3">
                      <strong className="text-ink">{inr(r.landedPaise)}</strong>
                      {!r.landedComplete ? <span className="mt-1 block text-xs text-muted">{fmt(t.incomplete, { what: what(r, t) })}</span> : null}
                    </td>
                    <td className="p-3">{r.quantity} {r.unit}</td>
                    <td className="p-3">{r.leadTimeDays == null ? t.notStated : fmt(t.days, { n: r.leadTimeDays })}</td>
                    <td className="p-3">{r.expired ? <Badge tone="danger">{t.expired}</Badge> : r.validUntil ?? t.notStated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <BoundsForm
            enquiryId={enquiryId}
            labels={t}
            defaults={{ targetRupees: bounds.targetPricePaise == null ? null : bounds.targetPricePaise / 100, ceilingRupees: bounds.ceilingPricePaise == null ? null : bounds.ceilingPricePaise / 100, maxLeadDays: bounds.maxLeadTimeDays }}
          />

          <ul className="flex flex-col gap-3" aria-label={t.colAction}>
            {cmp.rows.map((r) => (
              <li key={r.quoteId}>
                <Card>
                  <CardBody className="flex flex-col gap-3">
                    <p className="font-semibold text-ink">{r.sellerName}</p>
                    {r.counter?.status === "sent" ? (
                      <Alert tone="success"><strong>{t.counterSentBadge}</strong> {inr(r.counter.pricePaise)} / {r.unit}. {t.counterSentNote}</Alert>
                    ) : r.counter?.status === "proposed" ? (
                      <CounterEditor
                        enquiryId={enquiryId} sellerName={r.sellerName} unit={r.unit} labels={t}
                        c={{ id: r.counter.id, quotedPaise: r.counter.quotedPricePaise, priceRupees: r.counter.pricePaise / 100, leadTimeDays: r.counter.leadTimeDays, note: r.counter.note, rationale: r.counter.rationale, needsReview: r.counter.needsReview }}
                      />
                    ) : (
                      <SuggestCounter enquiryId={enquiryId} quoteId={r.quoteId} sellerName={r.sellerName} labels={t} />
                    )}
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <section aria-labelledby="neg-log-h" className="flex flex-col gap-2">
        <h3 id="neg-log-h" className="text-base font-semibold text-ink">{t.assistantHeading}</h3>
        {log.length === 0 ? <p className="text-sm text-muted">{t.assistantEmpty}</p> : (
          <ol className="flex flex-col gap-2">
            {log.map((a) => (
              <li key={a.id} className="rounded-lg border border-line p-3 text-sm">
                <Badge tone={a.byAssistant ? "neutral" : "success"}>{a.byAssistant ? t.actorAssistant : t.actorYou}</Badge>
                <p className="mt-1 text-ink">{logText(a, t)}</p>
                <time className="text-xs text-muted" dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function delivery(r: ComparisonRow, t: NegotiationLabels): string {
  if (r.deliveryIncluded === true && (r.deliveryChargePaise ?? 0) === 0) return t.deliveryIncluded;
  if (r.deliveryChargePaise != null && r.deliveryChargePaise > 0) return fmt(t.deliveryExtra, { amount: inr(r.deliveryChargePaise) });
  return r.deliveryIncluded === false ? t.deliveryExtraUnknown : t.deliveryUnknown;
}
function gst(r: ComparisonRow, t: NegotiationLabels): string {
  if (r.gstIncluded === true) return t.gstIncluded;
  if (r.gstIncluded === false) return r.gstPercent != null ? fmt(t.gstExtra, { pct: r.gstPercent }) : t.gstExtraUnknown;
  return t.gstUnknown;
}
function what(r: ComparisonRow, t: NegotiationLabels): string {
  const d = r.assumptions.includes("delivery_unknown"), g = r.assumptions.includes("gst_unknown");
  return d && g ? t.whatBoth : d ? t.whatDelivery : t.whatGst;
}
/** Localised sentence per action code; falls back to the stored English summary for unknown codes. */
function logText(a: AgentActionView, t: NegotiationLabels): string {
  const d = a.details as { pricePaise?: number; quoteIds?: unknown[] };
  switch (a.action) {
    case "quotes_normalised": return fmt(t.log_quotes_normalised, { n: d.quoteIds?.length ?? 0 });
    case "counter_proposed": return fmt(t.log_counter_proposed, { price: inr(d.pricePaise ?? 0) });
    case "counter_sent": return fmt(t.log_counter_sent, { price: inr(d.pricePaise ?? 0) });
    case "counter_discarded": return t.log_counter_discarded;
    case "counter_bounds_rejected": return t.log_counter_bounds_rejected;
    default: return a.summary;
  }
}
