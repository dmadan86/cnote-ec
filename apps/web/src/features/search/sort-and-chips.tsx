import { getTranslations } from "next-intl/server";
import { X } from "lucide-react";
import { formatINR } from "@cnote/core";
import { buttonClasses, Label, Select } from "@cnote/ui";
import type { Locale } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { chipSpecs, hasFilters, hrefFor, toSearchParams, type FilterState } from "./filter-state";

type Base = { q?: string; tab?: string };

/**
 * Sort control: a GET form with a visible Apply button, so changing the select never changes the page by itself (WCAG
 * 3.2.2). Every other parameter rides along as a hidden field. The note under it is the ranking promise: sponsored slots are
 * labelled and sit outside this order.
 */
export async function SortForm({ action, base, state, locale, options, idSuffix }: { action: string; base: Base; state: FilterState; locale: Locale; options: ("relevance" | "price_asc" | "price_desc" | "newest" | "trust")[]; idSuffix: string }) {
  const t = await getTranslations({ locale, namespace: "filters" });
  const label: Record<string, string> = { relevance: t("sortRelevance"), price_asc: t("sortPriceAsc"), price_desc: t("sortPriceDesc"), newest: t("sortNewest"), trust: t("sortTrust") };
  const carry = [...toSearchParams(base, { ...state, sort: "relevance" }).entries()];
  const id = `sort-${idSuffix}`;
  return (
    <form action={action} method="get" className="flex flex-wrap items-end gap-2">
      {carry.map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor={id} className="text-xs text-muted">{t("sortLabel")}</Label>
        <Select id={id} name="sort" defaultValue={state.sort} aria-describedby={`${id}-note`} className="h-11 w-auto min-w-52 lg:h-10">
          {options.map((o) => (
            <option key={o} value={o}>
              {label[o]}
            </option>
          ))}
        </Select>
      </div>
      <button type="submit" className={buttonClasses("outline", "md", "min-h-11 lg:min-h-10")}>
        {t("sortApply")}
      </button>
      <p id={`${id}-note`} className="basis-full text-xs text-muted">
        {t("sortNote")}
      </p>
    </form>
  );
}

/**
 * Applied-filter chips, each a link that removes just that constraint (URL-driven, so back works), plus "Clear all".
 * `stateName` localises state/city keys.
 */
export async function AppliedFilters({ path, base, state, locale, tierNames, categoryNames, stateName, lockCategories = false }: { lockCategories?: boolean; path: string; base: Base; state: FilterState; locale: Locale; tierNames: string[]; categoryNames: Record<string, string>; stateName: (k: string) => string }) {
  if (!hasFilters(state, lockCategories)) return null;
  const t = await getTranslations({ locale, namespace: "filters" });
  const rupees = (n: number) => formatINR(n * 100);
  const label = (kind: string, value: string): string => {
    switch (kind) {
      case "tier":
        return t("chipTier", { name: tierNames[Number(value)] ?? value });
      case "state":
        return t("chipState", { name: stateName(value) });
      case "city":
        return t("chipCity", { name: stateName(value) });
      case "category":
        return categoryNames[value] ?? value;
      case "price":
        return state.pmin !== null && state.pmax !== null ? t("chipPrice", { min: rupees(state.pmin), max: rupees(state.pmax) }) : state.pmin !== null ? t("chipPriceFrom", { min: rupees(state.pmin) }) : t("chipPriceTo", { max: rupees(state.pmax ?? 0) });
      case "moq":
        return t("chipMoq", { n: value });
      case "priced":
        return t("chipPriced");
      default:
        return t("chipDeliver", { pincode: value });
    }
  };
  const specs = chipSpecs(state, lockCategories);
  const cleared: FilterState = { ...state, tier: 0, states: [], cities: [], categories: lockCategories ? state.categories : [], pmin: null, pmax: null, moq: null, priced: false, deliver: null };
  return (
    <ul aria-label={t("applied")} className="flex flex-wrap items-center gap-2">
      {specs.map((c) => {
        const text = label(c.kind, c.value);
        return (
          <li key={`${c.kind}:${c.value}`}>
            <Link
              href={hrefFor(path, base, c.without)}
              aria-label={t("remove", { label: text })}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-brand-200 bg-brand-100 px-3 py-1 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 lg:min-h-8"
            >
              {text}
              <X className="size-3.5" aria-hidden />
            </Link>
          </li>
        );
      })}
      <li>
        <Link href={hrefFor(path, base, cleared)} className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-brand-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 lg:min-h-8">
          {t("clearAll")}
        </Link>
      </li>
    </ul>
  );
}
