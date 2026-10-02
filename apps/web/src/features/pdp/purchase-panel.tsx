"use client";
// Price + quantity slabs + estimate + CTAs, and the sticky mobile CTA bar. One client island so the slab table, the estimate,
// the CTAs (RFQ prefill) and the bar all share the buyer's quantity. The page around it stays static (ISR).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Field, Input, Money } from "@cnote/ui";
import { UnlockButton } from "@/features/leadgen/unlock-buttons";
import { activeSlabIndex, buildSlabs, estimateTotalPaise, formatPaise, parseQty, unitPriceFor, type Tier } from "./tiers";

export interface PurchasePanelProps {
  listingId: string;
  listingTitle: string;
  /** price unit ("piece", "kg", ...) */
  unit: string | null;
  basePaise: number | null;
  tiers: Tier[];
  moq: number | null;
  /** formatted "500 pcs" (server-built, locale-independent grouping) */
  moqText: string | null;
  moqUnit: string | null;
  /** existing `product.*` strings, passed down because that namespace is not shipped to the client */
  labels: { priceOnRequest: string; minOrder: string | null; indicative: string; getBestPrice: string; requestQuote: string };
  /** offer panel, rendered between the estimate and the buttons */
  offer?: ReactNode;
  /** save / compare islands */
  actions?: ReactNode;
}

const nf = new Intl.NumberFormat("en-IN");

export function PurchasePanel(p: PurchasePanelProps) {
  const t = useTranslations("pdp");
  const uid = useId();
  const slabs = buildSlabs(p.tiers, p.basePaise, p.moq);
  const hasPrice = p.basePaise != null || slabs.length > 0;
  const [raw, setRaw] = useState(String(p.moq ?? 1));
  const parsed = parseQty(raw);
  // An unusable quantity falls back to the MOQ for the numbers shown; the field reports the problem.
  const qty = parsed ?? p.moq ?? 1;
  const unitPaise = unitPriceFor(slabs, p.basePaise, qty);
  const total = estimateTotalPaise(unitPaise, qty);
  const active = activeSlabIndex(slabs, qty);
  const belowMoq = parsed != null && p.moq != null && parsed < p.moq;
  const unitLabel = p.moqUnit ?? p.unit ?? "";

  const ctaRef = useRef<HTMLDivElement>(null);
  const [barVisible, setBarVisible] = useState(false);
  useEffect(() => {
    const el = ctaRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // The bar appears while the in-page buttons are off screen, so the two never show at once.
    const io = new IntersectionObserver(([e]) => setBarVisible(!!e && !e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const prefill = { quantity: parsed, unit: p.moqUnit ?? p.unit, pricePaise: unitPaise };
  const buttons = (cls: string, size: "lg", suffix: string) => (
    <>
      <UnlockButton key={`best${suffix}`} trigger="pdp_best_price" unlock="enquiry" listingId={p.listingId} listingTitle={p.listingTitle} label={p.labels.getBestPrice} size={size} className={cls} />
      <UnlockButton key={`quote${suffix}`} trigger="request_quote" unlock="quotes" listingId={p.listingId} listingTitle={p.listingTitle} label={p.labels.requestQuote} variant="outline-brand" size={size} className={cls} prefill={prefill} />
    </>
  );

  return (
    <>
      <div>
        <div className="mt-3" data-testid="pdp-price">
          {unitPaise != null ? <Money paise={unitPaise} unit={p.unit} className="text-3xl" /> : <span className="text-lg font-semibold text-muted">{p.labels.priceOnRequest}</span>}
        </div>
        {p.labels.minOrder ? <p className="mt-1 text-sm text-muted">{p.labels.minOrder}</p> : null}
        <p className="mt-1 text-xs text-muted">{p.labels.indicative}</p>
      </div>

      {slabs.length ? (
        <section aria-labelledby={`${uid}-tiers`}>
          <h2 id={`${uid}-tiers`} className="text-base font-bold text-ink">
            {t("priceTiers")}
          </h2>
          <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
            <table className="w-full border-collapse text-sm" data-testid="pdp-slabs">
              <caption className="sr-only">{t("tiersCaption", { title: p.listingTitle })}</caption>
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">{t("colQuantity")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("colPrice")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {slabs.map((s, i) => (
                  <tr key={s.from} aria-current={i === active ? "true" : undefined} data-active={i === active ? "true" : undefined} className={i === active ? "bg-brand-50 font-semibold" : undefined}>
                    <th scope="row" className="px-4 py-2.5 text-left font-normal text-ink">
                      {s.to == null ? t("rangeOpen", { from: nf.format(s.from), unit: unitLabel }) : t("rangeBetween", { from: nf.format(s.from), to: nf.format(s.to), unit: unitLabel })}
                      {i === active ? <span className="ml-2 rounded-full border border-brand-600 px-2 py-0.5 text-xs font-semibold text-brand-700">{t("yourTier")}</span> : null}
                    </th>
                    <td className="px-4 py-2.5 text-ink">
                      <Money paise={s.pricePaise} unit={p.unit} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {hasPrice ? (
        <div className="rounded-card border border-line bg-surface p-4">
          <Field
            label={t("qtyLabel", { unit: unitLabel })}
            htmlFor={`${uid}-qty`}
            hint={belowMoq && p.moqText ? t("qtyBelowMoq", { moq: p.moqText }) : p.moqText ? t("qtyHintMoq", { moq: p.moqText }) : undefined}
            error={parsed == null ? t("qtyInvalid") : undefined}
          >
            <Input id={`${uid}-qty`} name="quantity" inputMode="numeric" autoComplete="off" value={raw} onChange={(e) => setRaw(e.target.value)} className="h-11 max-w-48" data-testid="pdp-qty" />
          </Field>
          {total != null ? (
            <p className="mt-3 text-sm text-ink" data-testid="pdp-estimate">
              <span className="text-muted">{t("estimatedTotal")}: </span>
              <span className="text-lg font-bold">{formatPaise(total)}</span>
              <span className="mt-0.5 block text-xs text-muted">{t("estimateNote")}</span>
            </p>
          ) : null}
          {/* One polite announcement per change, instead of the visible figures being a noisy live region. */}
          <p role="status" className="sr-only">
            {total != null && unitPaise != null ? t("liveSummary", { qty: nf.format(qty), unit: unitLabel, price: formatPaise(unitPaise), total: formatPaise(total) }) : ""}
          </p>
        </div>
      ) : null}

      {p.offer}

      <div ref={ctaRef} className="flex flex-wrap items-center gap-3">
        {buttons("w-full sm:w-auto", "lg", "-main")}
        {p.actions}
      </div>

      {barVisible ? (
        <div
          data-sticky-cta=""
          role="region"
          aria-label={t("stickyBar")}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-4px_12px_rgb(0_0_0/0.08)] md:hidden [html[data-consent-banner]_&]:bottom-[var(--consent-banner-h,12rem)]"
        >
          <p className="mb-2 flex items-baseline justify-between gap-3 text-sm">
            {unitPaise != null ? <Money paise={unitPaise} unit={p.unit} className="text-lg" /> : <span className="font-semibold text-muted">{p.labels.priceOnRequest}</span>}
            {total != null ? <span className="text-xs text-muted">{t("estimatedTotal")}: {formatPaise(total)}</span> : null}
          </p>
          <div className="flex gap-2">{buttons("flex-1 px-3", "lg", "-bar")}</div>
        </div>
      ) : null}
    </>
  );
}
