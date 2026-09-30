import { getTranslations } from "next-intl/server";
import type { PublicOffer } from "@cnote/promotions";
import { Money } from "@cnote/ui";
import { LOCALE_META, type Locale } from "@/i18n/config";
import { ReportOffer } from "./report-offer";

const fmt = (iso: string, locale: Locale) => new Intl.DateTimeFormat(LOCALE_META[locale].bcp47, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));
const rupees = (paise: number, locale: Locale) => new Intl.NumberFormat(LOCALE_META[locale].bcp47, { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);

/**
 * Honest offer block for the product page (server component, static/ISR).
 *  - The struck-through figure is ONLY the platform-computed lowest price of the last 30 days, labelled as such; with under 30 days
 *    of history the offer price is shown alone (no "was" price, no percentage).
 *  - "Ends" is the real end time as an absolute date. There is no countdown, no scarcity claim and nothing that resets.
 *  - Terms (units, GST, honouring) are on the block itself, not on a later screen.
 */
export async function OfferPanel({ offer, unit, locale }: { offer: PublicOffer; unit: string | null; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "promotions" });
  const first = offer.timed?.offerId ?? offer.tiers?.offerId ?? offer.freeDelivery?.offerId ?? "";
  return (
    <section aria-labelledby="offers-h" className="rounded-card border border-success/30 bg-green-50 p-4">
      <h2 id="offers-h" className="text-base font-bold text-ink">
        {t("heading")}
      </h2>

      {offer.timed ? (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-success">{t("timedLabel")}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Money paise={offer.timed.unitPricePaise} unit={unit} className="text-3xl" />
            {offer.timed.reference ? (
              <span className="text-sm text-muted">
                <span className="sr-only">{t("referenceSr")} </span>
                <s>{rupees(offer.timed.reference.pricePaise, locale)}</s>
              </span>
            ) : null}
          </p>
          {offer.timed.reference ? (
            <p className="mt-1 text-sm text-ink">
              {t("percentBelowFull", { percent: offer.timed.reference.percentOff })}
              <span className="block text-xs text-muted">{t("referenceLine")}: {rupees(offer.timed.reference.pricePaise, locale)}</span>
            </p>
          ) : null}
          <p className="mt-1 text-sm text-muted">
            <time dateTime={offer.timed.endsAt}>{t("timedEnds", { date: fmt(offer.timed.endsAt, locale) })}</time>
          </p>
        </div>
      ) : null}

      {offer.tiers ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink">{t("tiersHeading")}</h3>
          <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{t("tiersCaption")}</caption>
              <thead>
                <tr className="text-left text-muted">
                  <th scope="col" className="px-3 py-2 font-medium">{t("tierQty")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("tierPrice")}</th>
                  {offer.tiers.referencePaise ? <th scope="col" className="px-3 py-2 font-medium">{t("tierBelow")}</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {offer.tiers.tiers.map((r) => (
                  <tr key={r.minQty}>
                    <th scope="row" className="px-3 py-2 text-left font-medium text-ink">{t("tierQtyValue", { qty: r.minQty.toLocaleString(LOCALE_META[locale].bcp47) })}</th>
                    <td className="px-3 py-2"><Money paise={r.unitPricePaise} unit={unit} /></td>
                    {offer.tiers!.referencePaise ? <td className="px-3 py-2 text-ink">{r.percentOff ? t("percentBelow", { percent: r.percentOff }) : "–"}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {offer.tiers.endsAt ? <p className="mt-1 text-xs text-muted"><time dateTime={offer.tiers.endsAt}>{t("tiersEnds", { date: fmt(offer.tiers.endsAt, locale) })}</time></p> : null}
        </div>
      ) : null}

      {offer.freeDelivery ? (
        <div className="mt-4 text-sm text-ink">
          <h3 className="font-semibold">{t("freeDeliveryTitle")}</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {offer.freeDelivery.minQty ? <li>{t("freeDeliveryQty", { qty: offer.freeDelivery.minQty.toLocaleString(LOCALE_META[locale].bcp47) })}</li> : null}
            {offer.freeDelivery.minOrderValuePaise ? <li>{t("freeDeliveryValue", { amount: rupees(offer.freeDelivery.minOrderValuePaise, locale) })}</li> : null}
            {offer.freeDelivery.regions.length ? <li>{t("freeDeliveryRegions", { regions: offer.freeDelivery.regions.join(", ") })}</li> : null}
            {offer.freeDelivery.endsAt ? <li><time dateTime={offer.freeDelivery.endsAt}>{t("freeDeliveryEnds", { date: fmt(offer.freeDelivery.endsAt, locale) })}</time></li> : null}
          </ul>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-muted">{t("terms")}</p>
      <div className="mt-3">
        <ReportOffer
          offerId={first}
          labels={{ summary: t("reportSummary"), intro: t("reportIntro"), noteLabel: t("reportNoteLabel"), submit: t("reportSubmit"), sending: t("reportSending"), thanks: t("reportThanks") }}
        />
      </div>
    </section>
  );
}
