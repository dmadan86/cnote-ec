// URL <-> filter state for /search and /c/[slug]. Pure (no server-only or client-only imports): the URL is the single source
// of truth, so a filtered view is shareable and the back button works. Types only from @cnote/search (erased at build).
import type { SearchFilters, SearchSort } from "@cnote/search";
import { stateFromPincode, validPincode } from "./geo";

const SORT_VALUES = ["relevance", "price_asc", "price_desc", "newest", "trust"] as const;
const MAX_LIST = 10;
/** A state value no seller can have (used when two state constraints contradict). */
export const NO_STATE = "~no-state~";
const MAX_RUPEES = 1_000_000_000; // ₹100 crore: well inside Number.MAX_SAFE_INTEGER once x100

type Params = Record<string, string | string[] | undefined>;

export interface FilterState {
  /** minimum verification tier 1..3 (0 = any) */
  tier: number;
  states: string[];
  cities: string[];
  categories: string[];
  /** whole rupees, as typed */
  pmin: number | null;
  pmax: number | null;
  /** max MOQ in units */
  moq: number | null;
  /** hide "price on request" */
  priced: boolean;
  /** opt-in: the 6-digit pincode to deliver to (taken from the "Deliver to" picker by the toggle, then carried in the URL). null = off. */
  deliver: string | null;
  /** only listings that are in stock today (a filter, never a ranking signal) */
  inStock: boolean;
  /** variant axis -> lower-cased values (OR within an axis, AND across axes); URL form `variant=size:m` */
  variants: Record<string, string[]>;
  sort: SearchSort;
}

export const EMPTY_FILTERS: FilterState = { tier: 0, states: [], cities: [], categories: [], pmin: null, pmax: null, moq: null, priced: false, deliver: null, inStock: false, variants: {}, sort: "relevance" };

const MAX_VARIANT_AXES = 6;
const MAX_VARIANT_VALUES = 20;
const AXIS_RE = /^[a-z][a-z0-9_]{0,29}$/;

/** `variant=size:m&variant=size:l&variant=colour:red` -> { colour: ["red"], size: ["l","m"] }. Anything malformed is dropped. */
export function parseVariantParams(v: string | string[] | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const raw of all(v).flatMap((x) => x.split("|"))) {
    const i = raw.indexOf(":");
    if (i < 1) continue;
    const axis = raw.slice(0, i).trim().toLowerCase();
    const value = raw.slice(i + 1).trim().toLowerCase();
    if (!AXIS_RE.test(axis) || !value || value.length > 60) continue;
    if (!(axis in out) && Object.keys(out).length >= MAX_VARIANT_AXES) continue;
    const arr = (out[axis] ??= []);
    if (!arr.includes(value) && arr.length < MAX_VARIANT_VALUES) arr.push(value);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, vs]) => [k, [...vs].sort()]));
}

/** "size:xl" -> axis "size", value "xl" (null for a malformed facet key). */
export function splitVariantKey(key: string): { axis: string; value: string } | null {
  const i = key.indexOf(":");
  return i > 0 && i < key.length - 1 ? { axis: key.slice(0, i), value: key.slice(i + 1) } : null;
}

const variantCount = (v: Record<string, string[]>): number => Object.values(v).reduce((a, x) => a + x.length, 0);

/** Price buckets of the facet, in rupees, keyed as in the search facets. Shared by the panel and the URL parser. */
export const PRICE_BUCKETS: { key: string; min: number | null; max: number | null }[] = [
  { key: "under-1k", min: null, max: 999 },
  { key: "1k-10k", min: 1_000, max: 9_999 },
  { key: "10k-1l", min: 10_000, max: 99_999 },
  { key: "above-1l", min: 100_000, max: null },
];

const all = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const first = (v: string | string[] | undefined): string => (all(v)[0] ?? "").trim();
const list = (v: string | string[] | undefined, lower: boolean): string[] =>
  [...new Set(all(v).flatMap((x) => x.split(",")).map((x) => (lower ? x.trim().toLowerCase() : x.trim())).filter((x) => x.length > 0 && x.length <= 100))].slice(0, MAX_LIST);

function whole(v: string | string[] | undefined, min: number): number | null {
  const s = first(v).replace(/[,\s₹]/g, "");
  if (!/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= MAX_RUPEES ? n : null;
}

export function isSort(v: string): v is SearchSort {
  return (SORT_VALUES as readonly string[]).includes(v);
}

/** Never throws: anything unparseable is simply "no filter". */
export function parseFilterState(sp: Params): FilterState {
  const bucket = PRICE_BUCKETS.find((b) => b.key === first(sp.price));
  let pmin = whole(sp.pmin, 0) ?? bucket?.min ?? null;
  let pmax = whole(sp.pmax, 0) ?? bucket?.max ?? null;
  if (pmin !== null && pmax !== null && pmax < pmin) pmax = null; // contradictory range: keep the lower bound
  if (pmin === 0) pmin = null;
  const tier = Number.parseInt(first(sp.tier), 10);
  const sort = first(sp.sort);
  return {
    tier: Number.isInteger(tier) && tier >= 1 ? Math.min(3, tier) : 0,
    states: list(sp.state, true),
    cities: list(sp.city, true),
    categories: list(sp.category, false),
    pmin,
    pmax,
    moq: whole(sp.moq, 1),
    priced: first(sp.priced) === "1",
    deliver: validPincode(first(sp.deliver)),
    inStock: first(sp.instock) === "1",
    variants: parseVariantParams(sp.variant),
    sort: isSort(sort) ? sort : "relevance",
  };
}

/**
 * What to hand to searchListings. `deliver` (a pincode the buyer opted in to) becomes a state filter: we have no delivery-area
 * data, so "delivers to <pincode>" can only mean "located in the pincode's state". A pincode whose state we cannot derive
 * adds no filter (the toggle says so).
 */
export function toSearchArgs(s: FilterState): { filters: SearchFilters; sort: SearchSort } {
  const filters: SearchFilters = {};
  if (s.categories.length) filters.categories = s.categories;
  if (s.tier) filters.minTier = s.tier;
  // "Deliver to" is an AND with any states the buyer picked: only the buyer's own state can satisfy both. When they picked
  // other states only, nothing can match, expressed as a state no seller has.
  const mine = stateFromPincode(s.deliver)?.toLowerCase() ?? null;
  if (mine) filters.states = !s.states.length || s.states.includes(mine) ? [mine] : [NO_STATE];
  else if (s.states.length) filters.states = s.states;
  if (s.cities.length) filters.cities = s.cities;
  if (s.pmin !== null) filters.priceMinPaise = s.pmin * 100;
  if (s.pmax !== null) filters.priceMaxPaise = s.pmax * 100;
  if (s.moq !== null) filters.maxMoq = s.moq;
  if (s.priced) filters.hasPrice = true;
  if (s.inStock) filters.inStockOnly = true;
  if (Object.keys(s.variants).length) filters.variantOptions = s.variants;
  return { filters, sort: s.sort };
}

/** `lockCategories`: the category is the page itself (/c/[slug]), not something the buyer chose, so it does not count. */
export const hasFilters = (s: FilterState, lockCategories = false): boolean =>
  s.tier > 0 || s.states.length > 0 || s.cities.length > 0 || (!lockCategories && s.categories.length > 0) || s.pmin !== null || s.pmax !== null || s.moq !== null || s.priced || s.deliver !== null || s.inStock || variantCount(s.variants) > 0;

/** Number of independent constraints, for the "Filters (n)" button. Sort is not a filter. */
export function activeCount(s: FilterState, lockCategories = false): number {
  return (s.tier > 0 ? 1 : 0) + s.states.length + s.cities.length + (lockCategories ? 0 : s.categories.length) + (s.pmin !== null || s.pmax !== null ? 1 : 0) + (s.moq !== null ? 1 : 0) + (s.priced ? 1 : 0) + (s.deliver !== null ? 1 : 0) + (s.inStock ? 1 : 0) + variantCount(s.variants);
}

/** Canonical query string for a state (+ the non-filter params q/tab). Empty values are omitted, so default URLs stay clean. */
export function toSearchParams(base: { q?: string; tab?: string }, s: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (base.q) p.set("q", base.q);
  if (base.tab && base.tab !== "products") p.set("tab", base.tab);
  for (const c of s.categories) p.append("category", c);
  if (s.tier) p.set("tier", String(s.tier));
  for (const x of s.states) p.append("state", x);
  for (const x of s.cities) p.append("city", x);
  if (s.pmin !== null) p.set("pmin", String(s.pmin));
  if (s.pmax !== null) p.set("pmax", String(s.pmax));
  if (s.moq !== null) p.set("moq", String(s.moq));
  if (s.priced) p.set("priced", "1");
  if (s.deliver) p.set("deliver", s.deliver);
  if (s.inStock) p.set("instock", "1");
  for (const [axis, vs] of Object.entries(s.variants)) for (const v of vs) p.append("variant", `${axis}:${v}`);
  if (s.sort !== "relevance") p.set("sort", s.sort);
  return p;
}

export function hrefFor(path: string, base: { q?: string; tab?: string }, s: FilterState): string {
  const qs = toSearchParams(base, s).toString();
  return qs ? `${path}?${qs}` : path;
}

export type ChipKey = "tier" | "state" | "city" | "category" | "price" | "moq" | "priced" | "deliver" | "instock" | "variant";
export interface ChipSpec {
  kind: ChipKey;
  value: string;
  /** state with just this constraint removed */
  without: FilterState;
}

/** One entry per removable constraint, each carrying the state that results from removing it. */
export function chipSpecs(s: FilterState, lockCategories = false): ChipSpec[] {
  const out: ChipSpec[] = [];
  const drop = (patch: Partial<FilterState>): FilterState => ({ ...s, ...patch });
  for (const c of lockCategories ? [] : s.categories) out.push({ kind: "category", value: c, without: drop({ categories: s.categories.filter((x) => x !== c) }) });
  if (s.tier) out.push({ kind: "tier", value: String(s.tier), without: drop({ tier: 0 }) });
  for (const x of s.states) out.push({ kind: "state", value: x, without: drop({ states: s.states.filter((y) => y !== x) }) });
  for (const x of s.cities) out.push({ kind: "city", value: x, without: drop({ cities: s.cities.filter((y) => y !== x) }) });
  if (s.pmin !== null || s.pmax !== null) out.push({ kind: "price", value: `${s.pmin ?? ""}-${s.pmax ?? ""}`, without: drop({ pmin: null, pmax: null }) });
  if (s.moq !== null) out.push({ kind: "moq", value: String(s.moq), without: drop({ moq: null }) });
  if (s.priced) out.push({ kind: "priced", value: "1", without: drop({ priced: false }) });
  if (s.deliver) out.push({ kind: "deliver", value: s.deliver, without: drop({ deliver: null }) });
  if (s.inStock) out.push({ kind: "instock", value: "1", without: drop({ inStock: false }) });
  for (const [axis, vs] of Object.entries(s.variants)) {
    for (const v of vs) {
      const left = vs.filter((x) => x !== v);
      const variants = { ...s.variants, [axis]: left };
      if (!left.length) delete variants[axis];
      out.push({ kind: "variant", value: `${axis}:${v}`, without: drop({ variants }) });
    }
  }
  return out;
}

/** Radio value for the price-bucket group: the bucket whose range equals the current one, else "". */
export function activeBucket(s: FilterState): string {
  return PRICE_BUCKETS.find((b) => b.min === s.pmin && b.max === s.pmax)?.key ?? "";
}

/** "gujarat" -> "Gujarat", "tamil nadu" -> "Tamil Nadu". Fallback label when the state has no localised name. */
export function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
