"use client";
// Variant picker: one radio group (fieldset + legend) per category-defined axis. Every option is a real labelled radio, so it works
// with the keyboard (arrow keys move within a group) and a screen reader; stock is stated in TEXT on each option, a colour name is
// text too (no colour-only swatches). A polite live region announces the price and availability of the chosen variant.
import { useId } from "react";
import { useTranslations } from "next-intl";
import { availabilityText } from "./stock-status";
import { buildSlabs, formatPaise, unitPriceFor } from "./tiers";
import { useVariantSelection } from "./variant-context";
import { axisValues, optionAvailability, variantName, variantTerms, type Terms } from "./variants";

export function VariantSelector({ base, unit }: { base: Terms; unit: string | null }) {
  const t = useTranslations("pdp");
  const uid = useId();
  const { axes, variants, picks, selected, choose, clear } = useVariantSelection();
  if (!variants.length || !axes.length) return null;

  const remaining = axes.filter((a) => !picks[a.key]).map((a) => a.label);
  const terms = selected ? variantTerms(base, selected) : null;
  const unitPaise = terms ? unitPriceFor(buildSlabs(terms.priceTiers, terms.pricePaise, terms.moq), terms.pricePaise, terms.moq ?? 1) : null;
  const price = unitPaise != null ? `${formatPaise(unitPaise)}${unit ? ` / ${unit}` : ""}` : t("variants.priceOnRequest");
  const announcement = selected && terms
    ? t("variants.announce", { name: variantName(selected, axes), availability: availabilityText(t, selected.availability, terms.leadTimeDays), price })
    : "";

  return (
    <section aria-labelledby={`${uid}-h`} className="rounded-card border border-line bg-surface p-4" data-testid="pdp-variants">
      <h2 id={`${uid}-h`} className="text-base font-bold text-ink">{t("variants.title")}</h2>
      <div className="mt-3 flex flex-col gap-4">
        {axes.map((axis) => (
          <fieldset key={axis.key} className="min-w-0" aria-describedby={`${uid}-hint`}>
            <legend className="mb-1.5 text-sm font-semibold text-ink">
              {axis.label}
              {picks[axis.key] ? <span className="ml-1.5 font-normal text-muted">{picks[axis.key]}</span> : null}
            </legend>
            <div className="flex flex-wrap gap-2">
              {axisValues(variants, axis.key).map((value) => {
                const a = optionAvailability(variants, picks, axis.key, value);
                const tag = a === "out_of_stock" ? t("availability.out_of_stock") : a === "made_to_order" ? t("availability.made_to_order") : a === null ? t("variants.changesOthers") : null;
                const checked = picks[axis.key] === value;
                const id = `${uid}-${axis.key}-${value}`;
                return (
                  <label key={value} htmlFor={id} className="relative">
                    <input
                      id={id}
                      type="radio"
                      name={`${uid}-${axis.key}`}
                      value={value}
                      checked={checked}
                      onChange={() => choose(axis.key, value)}
                      className="peer sr-only"
                    />
                    <span className="flex min-h-11 min-w-11 cursor-pointer flex-col items-center justify-center rounded-md border border-line bg-surface px-3 py-1 text-center text-sm text-ink hover:border-brand-600 peer-checked:border-2 peer-checked:border-brand-700 peer-checked:bg-brand-50 peer-checked:font-semibold peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600">
                      <span>{value}</span>
                      {tag ? <span className="text-xs font-normal text-muted">{tag}</span> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <p id={`${uid}-hint`} className="mt-3 text-sm text-muted">
        {selected ? (
          <>
            <span className="font-medium text-ink">{variantName(selected, axes)}</span> · {t("variants.sku", { sku: selected.sku })}
          </>
        ) : (
          t("variants.choose", { axes: remaining.join(", ") })
        )}
      </p>
      {Object.keys(picks).length ? (
        <button type="button" onClick={clear} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
          {t("variants.reset")}
        </button>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only" data-testid="pdp-variant-live">
        {announcement}
      </p>
    </section>
  );
}
