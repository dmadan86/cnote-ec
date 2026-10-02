import { getTranslations } from "next-intl/server";
import { buttonClasses, Input, Label } from "@cnote/ui";
import type { FacetCounts } from "@cnote/search";
import { LocaleLink as Link } from "@/i18n/link";
import type { Locale } from "@/i18n/config";
import { formatNumber } from "@/i18n/config";
import { DeliverToggle } from "./deliver-toggle";
import { hasFilters, hrefFor, PRICE_BUCKETS, type FilterState } from "./filter-state";

export type PanelFacets = Partial<Pick<FacetCounts, "category" | "city" | "state" | "verificationTier" | "price">>;

export interface PanelProps {
  /** Distinguishes the sidebar copy from the sheet copy so element ids stay unique. */
  idPrefix: "side" | "sheet";
  /** Localised form action (GET). */
  action: string;
  kind: "products" | "sellers";
  /** q / tab, carried through the form. */
  base: { q?: string; tab?: string };
  state: FilterState;
  facets?: PanelFacets;
  showCategories: boolean;
  categoryNames: Record<string, string>;
  stateName: (key: string) => string;
  tierNames: string[];
  /** Path used for the price-bucket quick links and "Clear all". */
  path: string;
  locale: Locale;
}

const VISIBLE = 8;

interface Item {
  key: string;
  label: string;
  count?: number;
}

function Group({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <legend className="mb-2 text-sm font-semibold text-ink">{legend}</legend>
      <div className="flex flex-col gap-0.5">{children}</div>
    </fieldset>
  );
}

const ROW = "flex min-h-11 items-center gap-2.5 rounded-md text-sm text-ink lg:min-h-8";
const BOX = "size-4 shrink-0 accent-brand-600";

function Checks({ name, items, selected, more, less, locale }: { name: string; items: Item[]; selected: string[]; more: string; less: string; locale: Locale }) {
  const shown = items.filter((i, idx) => idx < VISIBLE || selected.includes(i.key));
  const rest = items.filter((i) => !shown.includes(i));
  const row = (i: Item) => (
    <label key={i.key} className={ROW}>
      <input type="checkbox" name={name} value={i.key} defaultChecked={selected.includes(i.key)} className={BOX} />
      <span className="min-w-0 flex-1 truncate">{i.label}</span>
      {i.count !== undefined ? <span className="text-muted">({formatNumber(i.count, locale)})</span> : null}
    </label>
  );
  return (
    <>
      {shown.map(row)}
      {rest.length ? (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-medium text-brand-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 lg:min-h-8">
            <span className="group-open:hidden">{more}</span>
            <span className="hidden group-open:inline">{less}</span>
          </summary>
          {rest.map(row)}
        </details>
      ) : null}
    </>
  );
}

/**
 * The filter form. A plain GET form: with or without JavaScript, submitting writes the filters into the URL (shareable,
 * back-button friendly, and the results page stays server-rendered/cached per URL). Counts are disjunctive facet counts
 * from the search module; selecting a value never hides its siblings. Rendered twice (desktop sidebar + mobile sheet).
 */
export async function FiltersPanel(p: PanelProps) {
  const t = await getTranslations({ locale: p.locale, namespace: "filters" });
  const id = (n: string) => `${p.idPrefix}-${n}`;
  const f = p.facets;
  const s = p.state;

  const tierCounts = new Map((f?.verificationTier ?? []).map((b) => [Number(b.key), b.count]));
  const atLeast = (n: number) => (f?.verificationTier ? [...tierCounts].filter(([k]) => k >= n).reduce((a, [, c]) => a + c, 0) : undefined);

  const states: Item[] = (f?.state ?? []).map((b) => ({ key: b.key, label: p.stateName(b.key), count: b.count }));
  for (const k of s.states) if (!states.some((i) => i.key === k)) states.push({ key: k, label: p.stateName(k), count: 0 });
  const cities: Item[] = (f?.city ?? []).map((b) => ({ key: b.key, label: p.stateName(b.key), count: b.count }));
  for (const k of s.cities) if (!cities.some((i) => i.key === k)) cities.push({ key: k, label: p.stateName(k), count: 0 });
  const cats: Item[] = (f?.category ?? []).filter((b) => p.categoryNames[b.key]).map((b) => ({ key: b.key, label: p.categoryNames[b.key]!, count: b.count }));
  for (const k of s.categories) if (!cats.some((i) => i.key === k)) cats.push({ key: k, label: p.categoryNames[k] ?? k, count: 0 });

  const bucketLabel: Record<string, string> = { "under-1k": t("priceUnder1k"), "1k-10k": t("price1k10k"), "10k-1l": t("price10k1l"), "above-1l": t("priceAbove1l") };
  const priceCount = new Map((f?.price ?? []).map((b) => [b.key, b.count]));
  const bucketActive = (b: (typeof PRICE_BUCKETS)[number]) => s.pmin === b.min && s.pmax === b.max;

  return (
    <form action={p.action} method="get" className="flex flex-col gap-5" aria-label={t("title")}>
      {p.base.q ? <input type="hidden" name="q" value={p.base.q} /> : null}
      {p.base.tab && p.base.tab !== "products" ? <input type="hidden" name="tab" value={p.base.tab} /> : null}
      {s.sort !== "relevance" ? <input type="hidden" name="sort" value={s.sort} /> : null}
      {/* on /c/[slug] the category is the page, not a checkbox: carry it through as a hidden field */}
      {p.kind === "products" && !p.showCategories ? s.categories.map((c) => <input key={c} type="hidden" name="category" value={c} />) : null}

      <Group legend={t("tierTitle")}>
        {[0, 1, 2, 3].map((n) => (
          <label key={n} className={ROW}>
            <input type="radio" name="tier" value={String(n)} defaultChecked={s.tier === n} className={BOX} />
            <span className="min-w-0 flex-1">{n === 0 ? t("tierAny") : t("tierAtLeast", { name: p.tierNames[n] ?? String(n) })}</span>
            {atLeast(n) !== undefined ? <span className="text-muted">({formatNumber(atLeast(n)!, p.locale)})</span> : null}
          </label>
        ))}
      </Group>

      {p.kind === "products" && p.showCategories && cats.length ? (
        <Group legend={t("categoryTitle")}>
          <Checks name="category" items={cats} selected={s.categories} more={t("showMore")} less={t("showFewer")} locale={p.locale} />
        </Group>
      ) : null}

      {states.length ? (
        <Group legend={t("stateTitle")}>
          <Checks name="state" items={states} selected={s.states} more={t("showMore")} less={t("showFewer")} locale={p.locale} />
        </Group>
      ) : null}

      {cities.length ? (
        <Group legend={t("cityTitle")}>
          <Checks name="city" items={cities} selected={s.cities} more={t("showMore")} less={t("showFewer")} locale={p.locale} />
        </Group>
      ) : null}

      {p.kind === "products" ? (
        <>
          <Group legend={t("priceTitle")}>
            <nav aria-label={t("priceTitle")}>
              <ul className="flex flex-col gap-0.5">
                {PRICE_BUCKETS.map((b) => (
                  <li key={b.key}>
                    <Link
                      href={hrefFor(p.path, p.base, { ...s, pmin: bucketActive(b) ? null : b.min, pmax: bucketActive(b) ? null : b.max })}
                      aria-current={bucketActive(b) ? "true" : undefined}
                      className={`${ROW} no-underline hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${bucketActive(b) ? "font-semibold text-brand-700" : ""}`}
                    >
                      <span className="min-w-0 flex-1">{bucketLabel[b.key]}</span>
                      {f?.price ? <span className="text-muted">({formatNumber(priceCount.get(b.key) ?? 0, p.locale)})</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={id("pmin")} className="text-xs">{t("priceMin")}</Label>
                <Input id={id("pmin")} name="pmin" type="number" inputMode="numeric" min={0} step={1} defaultValue={s.pmin ?? ""} className="h-11 lg:h-10" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={id("pmax")} className="text-xs">{t("priceMax")}</Label>
                <Input id={id("pmax")} name="pmax" type="number" inputMode="numeric" min={0} step={1} defaultValue={s.pmax ?? ""} className="h-11 lg:h-10" />
              </div>
            </div>
            <label className={`${ROW} mt-1`}>
              <input type="checkbox" name="priced" value="1" defaultChecked={s.priced} className={BOX} />
              <span>{t("pricedOnly")}</span>
            </label>
          </Group>

          <Group legend={t("moqTitle")}>
            <Label htmlFor={id("moq")} className="text-xs">{t("moqLabel")}</Label>
            <Input id={id("moq")} name="moq" type="number" inputMode="numeric" min={1} step={1} defaultValue={s.moq ?? ""} aria-describedby={id("moq-hint")} className="h-11 lg:h-10" />
            <p id={id("moq-hint")} className="text-xs text-muted">{t("moqHint")}</p>
          </Group>
        </>
      ) : null}

      <Group legend={t("deliverTitle")}>
        <DeliverToggle id={id("deliver")} current={s.deliver} />
      </Group>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" className={buttonClasses("primary", "md", "min-h-11 lg:min-h-10")}>
          {t("apply")}
        </button>
        {hasFilters(s, !p.showCategories) ? (
          <Link href={hrefFor(p.path, p.base, { ...s, tier: 0, states: [], cities: [], categories: p.showCategories ? [] : s.categories, pmin: null, pmax: null, moq: null, priced: false, deliver: null })} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 lg:min-h-8">
            {t("clearAll")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
