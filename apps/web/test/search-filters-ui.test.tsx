import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next-intl: keys echo back with their arguments so the markup shows which message was used.
const msg = (k: string, a?: Record<string, unknown>) => (a ? `${k}${JSON.stringify(a)}` : k);
vi.mock("next-intl/server", () => ({ getTranslations: async () => msg }));
vi.mock("next-intl", () => ({ useTranslations: () => msg, useLocale: () => "en" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: unknown }) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
vi.mock("@cnote/core", () => ({ formatINR: (p: number) => `₹${p / 100}` }));

const { FiltersPanel } = await import("@/features/search/filters-panel");
const { AppliedFilters, SortForm } = await import("@/features/search/sort-and-chips");
const { FiltersSheet } = await import("@/features/search/filters-sheet");
const { EMPTY_FILTERS } = await import("@/features/search/filter-state");

const facets = {
  verificationTier: [{ key: "3", count: 2 }, { key: "1", count: 5 }],
  state: [{ key: "gujarat", count: 4 }, { key: "delhi", count: 3 }],
  city: [{ key: "surat", count: 2 }],
  category: [{ key: "packaging", count: 7 }],
  price: [{ key: "under-1k", fromPaise: null, toPaise: 100000, count: 1 }, { key: "1k-10k", fromPaise: 100000, toPaise: 1000000, count: 6 }],
};
const base = {
  idPrefix: "side" as const, action: "/search", kind: "products" as const, base: { q: "box" }, showCategories: true, categoryNames: { packaging: "Packaging" },
  stateName: (k: string) => k.toUpperCase(), tierNames: ["Phone", "GST", "KYC", "Audited"], path: "/search", locale: "en" as const, facets,
};
/** The <input> with this name (and value), attribute order does not matter. */
const input = (out: string, name: string, value?: string) =>
  [...out.matchAll(/<input[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`name="${name}"`) && (value === undefined || t.includes(`value="${value}"`)));
const html = async (el: Promise<React.ReactNode>) => renderToStaticMarkup(<>{await el}</>);

describe("FiltersPanel", () => {
  it("is a GET form that carries q and has labelled controls with disjunctive counts", async () => {
    const out = await html(FiltersPanel({ ...base, state: EMPTY_FILTERS }));
    expect(out).toContain('method="get"');
    expect(out).toContain('name="q" value="box"');
    expect(out).toContain('name="tier"');
    expect(out).toContain('name="state" value="gujarat"');
    expect(out).toContain("GUJARAT");
    expect(out).toContain("(4)");
    expect(out).toContain('name="category" value="packaging"');
    // every input has a label (jsx-a11y) and ids carry the prefix so the sidebar and the sheet never clash
    expect(out).toContain('id="side-pmin"');
    expect(out).toContain('for="side-pmin"');
    expect(out).toContain('id="side-moq"');
    expect(out).not.toContain('id="sheet-');
  });
  it("tier counts are cumulative ('or higher')", async () => {
    const out = await html(FiltersPanel({ ...base, state: EMPTY_FILTERS }));
    expect(out).toContain("(7)"); // any = 2 + 5
    expect(out).toMatch(/tierAtLeast\{&quot;name&quot;:&quot;GST&quot;\}<\/span><span class="text-muted">\(7\)/); // tier>=1 = 7
    expect(out).toMatch(/Audited[^<]*<\/span><span class="text-muted">\(2\)/); // tier>=3 = 2
  });
  it("reflects the current state: checked boxes, selected radio, typed values, clear-all link", async () => {
    const out = await html(FiltersPanel({ ...base, state: { ...EMPTY_FILTERS, tier: 1, states: ["delhi"], pmin: 500, moq: 20 } }));
    expect(input(out, "tier", "1")).toContain("checked");
    expect(input(out, "tier", "0")).not.toContain("checked");
    expect(input(out, "state", "delhi")).toContain("checked");
    expect(input(out, "state", "gujarat")).not.toContain("checked");
    expect(input(out, "pmin")).toContain('value="500"');
    expect(input(out, "moq")).toContain('value="20"');
    expect(out).toContain("clearAll");
  });
  it("selected values that have no facet bucket (count 0) stay visible so they can be unticked", async () => {
    const out = await html(FiltersPanel({ ...base, state: { ...EMPTY_FILTERS, states: ["goa"] } }));
    expect(input(out, "state", "goa")).toContain("checked");
  });
  it("price buckets are links that keep every other filter; the active one is aria-current", async () => {
    const out = await html(FiltersPanel({ ...base, state: { ...EMPTY_FILTERS, tier: 2, pmin: 1000, pmax: 9999 } }));
    expect(out).toContain('href="/search?q=box&amp;tier=2&amp;pmin=1000&amp;pmax=9999"'.replace("pmin=1000&amp;pmax=9999", "pmax=999")); // under-1k link
    expect(out).toMatch(/aria-current="true"[^>]*>[^]*price1k10k/);
  });
  it("on /c the category is a hidden field, not a checkbox group", async () => {
    const out = await html(FiltersPanel({ ...base, showCategories: false, state: { ...EMPTY_FILTERS, categories: ["packaging"] }, base: {} }));
    expect(out).toContain('type="hidden" name="category" value="packaging"');
    expect(out).not.toContain('type="checkbox" name="category"');
  });
  it("the suppliers tab drops price, MOQ and category groups", async () => {
    const out = await html(FiltersPanel({ ...base, kind: "sellers", state: EMPTY_FILTERS }));
    expect(out).not.toContain('name="pmin"');
    expect(out).not.toContain('name="moq"');
    expect(out).toContain('name="tier"');
  });
  it("delivery toggle is an opt-in checkbox, unchecked by default", async () => {
    const out = await html(FiltersPanel({ ...base, state: EMPTY_FILTERS }));
    expect(input(out, "deliver")).toContain('type="checkbox"');
    expect(input(out, "deliver")).not.toContain("checked");
  });
  it("when the URL carries a pincode the toggle is checked and submits that pincode", async () => {
    const out = await html(FiltersPanel({ ...base, state: { ...EMPTY_FILTERS, deliver: "560001" } }));
    expect(input(out, "deliver")).toContain("checked");
    expect(input(out, "deliver")).toContain('value="560001"');
    expect(input(out, "deliver")).not.toContain("disabled");
    expect(out).toContain("deliverNote{&quot;state&quot;:&quot;Karnataka&quot;}");
  });
});

describe("SortForm", () => {
  it("is a form with a visible apply button (no auto-submit) and carries other params", async () => {
    const out = await html(SortForm({ action: "/search", base: { q: "box" }, state: { ...EMPTY_FILTERS, tier: 2, sort: "price_asc" }, locale: "en", options: ["relevance", "price_asc"], idSuffix: "products" }));
    expect(out).toContain('type="hidden" name="q" value="box"');
    expect(out).toContain('type="hidden" name="tier" value="2"');
    expect(out).not.toContain('name="sort" value="price_asc"'); // sort itself is the select
    expect(out).toMatch(/<option value="price_asc" selected/);
    expect(out).toContain("sortApply");
    expect(out).toContain('for="sort-products"');
    expect(out).toContain("sortNote");
  });
});

describe("AppliedFilters", () => {
  const props = { path: "/search", base: { q: "box" }, locale: "en" as const, tierNames: ["Phone", "GST", "KYC", "Audited"], categoryNames: { packaging: "Packaging" }, stateName: (k: string) => k.toUpperCase() };
  it("renders nothing without filters", async () => expect(await AppliedFilters({ ...props, state: EMPTY_FILTERS })).toBeNull());
  it("each chip is a link that removes only itself, named for assistive tech; Clear all resets everything but sort", async () => {
    const out = await html(AppliedFilters({ ...props, state: { ...EMPTY_FILTERS, tier: 2, states: ["delhi"], pmax: 500, sort: "newest" } }));
    expect(out).toContain('aria-label="applied"');
    expect(out).toMatch(/href="\/search\?q=box&amp;state=delhi&amp;pmax=500&amp;sort=newest"[^>]*aria-label="remove\{&quot;label&quot;:&quot;chipTier/); // tier chip removed
    expect(out).toContain("chipPriceTo");
    expect(out).toContain('href="/search?q=box&amp;sort=newest"'); // clear all
  });
  it("delivery chip names the pincode from the URL", async () => {
    const out = await html(AppliedFilters({ ...props, state: { ...EMPTY_FILTERS, deliver: "560001" } }));
    expect(out).toContain("chipDeliver{&quot;pincode&quot;:&quot;560001&quot;}");
  });
});

describe("FiltersSheet", () => {
  it("renders a Filters button (with the active count) and a native, labelled dialog", () => {
    const out = renderToStaticMarkup(<FiltersSheet count={3}><p>inside</p></FiltersSheet>);
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).toContain('openCount{&quot;count&quot;:3}');
    expect(out).toContain('<dialog aria-labelledby="filters-sheet-title"');
    expect(out).toContain('id="filters-sheet-title"');
    expect(out).toContain('aria-label="close"');
    expect(out).toContain("lg:hidden"); // desktop uses the sidebar copy
    expect(renderToStaticMarkup(<FiltersSheet count={0}><i /></FiltersSheet>)).toContain(">open<");
  });
});
