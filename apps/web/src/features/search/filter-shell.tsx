import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { localizePath } from "@/i18n/config";
import enStates from "../../../messages/en.states.json";
import { activeCount, titleCase, type FilterState } from "./filter-state";
import { FiltersPanel, type PanelFacets } from "./filters-panel";
import { FiltersSheet } from "./filters-sheet";
import { AppliedFilters, SortForm } from "./sort-and-chips";

const STATE_CODE_BY_NAME = new Map(Object.entries(enStates.states).map(([code, name]) => [name.toLowerCase(), code]));

/** Localised state name for a lower-cased state key (GST state-code catalogue); anything unknown falls back to Title Case. */
export async function stateNamer(locale: Locale): Promise<(key: string) => string> {
  const t = await getTranslations({ locale, namespace: "states" });
  return (key) => {
    const code = STATE_CODE_BY_NAME.get(key.toLowerCase());
    return code ? t(code as never) : titleCase(key);
  };
}

export async function tierNamesFor(locale: Locale): Promise<string[]> {
  const t = await getTranslations({ locale, namespace: "cards" });
  return [t("tier0"), t("tier1"), t("tier2"), t("tier3")];
}

export interface ShellProps {
  locale: Locale;
  kind: "products" | "sellers";
  /** Path (unlocalised) that results live on; filters submit here. */
  path: string;
  base: { q?: string; tab?: string };
  state: FilterState;
  facets?: PanelFacets;
  /** false on /c/[slug], where the category is the page itself and is submitted as a hidden field instead. */
  showCategories: boolean;
  categoryNames: Record<string, string>;
  children: React.ReactNode;
}

/**
 * Filter sidebar (desktop) + "Filters" sheet (mobile) + sort + applied chips around a results body. Everything is driven by
 * the URL state passed in; nothing here reads cookies or request data, so pages that use it stay as cacheable as before.
 */
export async function FilterShell(p: ShellProps) {
  const [t, stateName, tierNames] = await Promise.all([getTranslations({ locale: p.locale, namespace: "filters" }), stateNamer(p.locale), tierNamesFor(p.locale)]);
  const action = localizePath(p.path, p.locale);
  const panel = (idPrefix: "side" | "sheet") => (
    <FiltersPanel idPrefix={idPrefix} action={action} kind={p.kind} base={p.base} state={p.state} facets={p.facets} showCategories={p.showCategories} categoryNames={p.categoryNames} stateName={stateName} tierNames={tierNames} path={p.path} locale={p.locale} />
  );
  const sortOptions = p.kind === "products" ? (["relevance", "price_asc", "price_desc", "newest", "trust"] as const) : (["relevance", "trust"] as const);
  return (
    <div className="mt-6 lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-8">
      <aside aria-label={t("title")} className="hidden lg:block">
        {panel("side")}
      </aside>
      <div className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <FiltersSheet count={activeCount(p.state, !p.showCategories)}>{panel("sheet")}</FiltersSheet>
          <SortForm action={action} base={p.base} state={p.state} locale={p.locale} options={[...sortOptions]} idSuffix={p.kind} />
        </div>
        <div className="mt-3">
          <AppliedFilters path={p.path} base={p.base} state={p.state} locale={p.locale} tierNames={tierNames} categoryNames={p.categoryNames} stateName={stateName} lockCategories={!p.showCategories} />
        </div>
        <div className="mt-6">{p.children}</div>
      </div>
    </div>
  );
}
