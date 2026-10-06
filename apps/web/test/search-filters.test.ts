import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS, NO_STATE, activeBucket, activeCount, chipSpecs, hasFilters, hrefFor, parseFilterState, titleCase, toSearchArgs, toSearchParams, type FilterState,
} from "@/features/search/filter-state";

const parse = (qs: string) => parseFilterState(Object.fromEntries([...new URLSearchParams(qs)].map(([k]) => [k, new URLSearchParams(qs).getAll(k)])));

describe("parseFilterState (URL -> state)", () => {
  it("no params is the empty state", () => expect(parse("")).toEqual(EMPTY_FILTERS));
  it("reads every filter", () => {
    const s = parse("tier=2&state=Gujarat&state=delhi&city=Surat&category=a&category=b&pmin=500&pmax=2,000&moq=100&priced=1&deliver=560001&sort=price_asc");
    expect(s).toEqual({ tier: 2, states: ["gujarat", "delhi"], cities: ["surat"], categories: ["a", "b"], pmin: 500, pmax: 2000, moq: 100, priced: true, deliver: "560001", inStock: false, variants: {}, sort: "price_asc" });
  });
  it("accepts a comma list and repeated keys alike, de-duplicates and caps at 10", () => {
    expect(parse("state=a,b,a").states).toEqual(["a", "b"]);
    expect(parse(`state=${Array.from({ length: 30 }, (_, i) => `s${i}`).join(",")}`).states).toHaveLength(10);
  });
  it("ignores garbage instead of throwing", () => {
    expect(parse("tier=9&pmin=abc&pmax=-5&moq=0&sort=cheapest&priced=yes")).toMatchObject({ tier: 3, pmin: null, pmax: null, moq: null, sort: "relevance", priced: false });
    expect(parse("tier=0").tier).toBe(0);
    expect(parse("pmin=99999999999999999999").pmin).toBeNull();
  });
  it("a contradictory price range keeps the lower bound; pmin=0 is no lower bound", () => {
    expect(parse("pmin=500&pmax=100")).toMatchObject({ pmin: 500, pmax: null });
    expect(parse("pmin=0").pmin).toBeNull();
  });
  it("the legacy price bucket param maps to its range", () => {
    expect(parse("price=1k-10k")).toMatchObject({ pmin: 1000, pmax: 9999 });
    expect(parse("price=above-1l")).toMatchObject({ pmin: 100000, pmax: null });
    expect(parse("price=nope")).toMatchObject({ pmin: null, pmax: null });
    expect(activeBucket(parse("pmin=1000&pmax=9999"))).toBe("1k-10k");
    expect(activeBucket(parse("pmin=1&pmax=2"))).toBe("");
  });
  it("accepts single (non-array) Next searchParams values too", () => {
    expect(parseFilterState({ tier: "3", state: "Kerala", sort: "newest" })).toMatchObject({ tier: 3, states: ["kerala"], sort: "newest" });
  });
});

describe("state -> URL", () => {
  it("default state is a clean URL", () => {
    expect(hrefFor("/search", { q: "box", tab: "products" }, EMPTY_FILTERS)).toBe("/search?q=box");
    expect(hrefFor("/search", {}, EMPTY_FILTERS)).toBe("/search");
  });
  it("round-trips: parse(toSearchParams(state)) === state", () => {
    const s: FilterState = { tier: 3, states: ["delhi", "gujarat"], cities: ["surat"], categories: ["a"], pmin: 10, pmax: 900, moq: 5, priced: true, deliver: "400069", inStock: true, variants: { colour: ["red"], size: ["l", "m"] }, sort: "trust" };
    expect(parse(toSearchParams({ q: "x" }, s).toString())).toEqual(s);
  });
  it("keeps non-default tabs, drops the default one", () => {
    expect(toSearchParams({ q: "x", tab: "manufacturers" }, EMPTY_FILTERS).toString()).toBe("q=x&tab=manufacturers");
  });
  it("property: any parsed state round-trips and the URL is stable", () =>
    fc.assert(
      fc.property(
        fc.record({
          tier: fc.option(fc.integer({ min: -2, max: 6 }), { nil: undefined }),
          state: fc.array(fc.constantFrom("Gujarat", "delhi", "Tamil Nadu", " "), { maxLength: 4 }),
          pmin: fc.option(fc.integer({ min: -10, max: 5_000_000 }), { nil: undefined }),
          pmax: fc.option(fc.integer({ min: -10, max: 5_000_000 }), { nil: undefined }),
          moq: fc.option(fc.integer({ min: -3, max: 100000 }), { nil: undefined }),
          sort: fc.constantFrom("relevance", "price_asc", "price_desc", "newest", "trust", "junk"),
          priced: fc.boolean(),
          deliver: fc.option(fc.constantFrom("560001", "110020", "12345", "abc"), { nil: undefined }),
        }),
        (r) => {
          const sp = { ...(r.tier !== undefined ? { tier: String(r.tier) } : {}), state: r.state, ...(r.pmin !== undefined ? { pmin: String(r.pmin) } : {}), ...(r.pmax !== undefined ? { pmax: String(r.pmax) } : {}), ...(r.moq !== undefined ? { moq: String(r.moq) } : {}), sort: r.sort, ...(r.priced ? { priced: "1" } : {}), ...(r.deliver ? { deliver: r.deliver } : {}) };
          const s = parseFilterState(sp);
          const url = toSearchParams({}, s).toString();
          expect(parse(url)).toEqual(s);
          expect(toSearchParams({}, parse(url)).toString()).toBe(url);
        },
      ),
    ));
});

describe("state -> search arguments", () => {
  it("converts rupees to paise and maps every field", () => {
    const { filters, sort } = toSearchArgs({ ...EMPTY_FILTERS, tier: 2, states: ["delhi"], cities: ["x"], categories: ["c"], pmin: 5, pmax: 10, moq: 7, priced: true, sort: "newest" });
    expect(filters).toEqual({ categories: ["c"], minTier: 2, states: ["delhi"], cities: ["x"], priceMinPaise: 500, priceMaxPaise: 1000, maxMoq: 7, hasPrice: true });
    expect(sort).toBe("newest");
  });
  it("empty state yields no filters at all", () => expect(toSearchArgs(EMPTY_FILTERS).filters).toEqual({}));
  it("deliver-to is opt-in: absent from the URL means no location filter, whatever cookie the buyer has", () => {
    expect(toSearchArgs(EMPTY_FILTERS).filters).toEqual({});
    expect(parse("").deliver).toBeNull();
    expect(parse("deliver=1").deliver).toBeNull(); // not a pincode
    expect(parse("deliver=012345").deliver).toBeNull();
  });
  it("deliver=<pincode> narrows to the pincode's state; an unmappable pincode adds nothing", () => {
    expect(toSearchArgs({ ...EMPTY_FILTERS, deliver: "560001" }).filters.states).toEqual(["karnataka"]);
    expect(toSearchArgs({ ...EMPTY_FILTERS, deliver: "999999" }).filters.states).toBeUndefined();
  });
  it("deliver-to ANDs with chosen states: only the buyer's own state can satisfy both", () => {
    expect(toSearchArgs({ ...EMPTY_FILTERS, deliver: "560001", states: ["karnataka", "goa"] }).filters.states).toEqual(["karnataka"]);
    expect(toSearchArgs({ ...EMPTY_FILTERS, deliver: "560001", states: ["goa"] }).filters.states).toEqual([NO_STATE]);
  });
});

describe("chips and counts", () => {
  const s: FilterState = { ...EMPTY_FILTERS, tier: 2, states: ["delhi", "goa"], categories: ["a"], pmin: 5, moq: 3, priced: true, deliver: "560001" };
  it("one chip per removable constraint; removing one leaves the rest", () => {
    const specs = chipSpecs(s);
    expect(specs.map((c) => c.kind)).toEqual(["category", "tier", "state", "state", "price", "moq", "priced", "deliver"]);
    const delhi = specs.find((c) => c.kind === "state" && c.value === "delhi")!;
    expect(delhi.without.states).toEqual(["goa"]);
    expect(delhi.without.tier).toBe(2);
    expect(specs.find((c) => c.kind === "price")!.without).toMatchObject({ pmin: null, pmax: null });
  });
  it("a locked category (the /c page itself) is not a chip and not counted", () => {
    expect(chipSpecs(s, true).some((c) => c.kind === "category")).toBe(false);
    expect(activeCount(s)).toBe(activeCount(s, true) + 1);
    expect(hasFilters({ ...EMPTY_FILTERS, categories: ["a"] }, true)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, categories: ["a"] })).toBe(true);
  });
  it("sort alone is not a filter", () => {
    expect(hasFilters({ ...EMPTY_FILTERS, sort: "newest" })).toBe(false);
    expect(activeCount({ ...EMPTY_FILTERS, sort: "newest" })).toBe(0);
  });
  it("title-cases state keys", () => expect(titleCase("tamil nadu")).toBe("Tamil Nadu"));
});

describe("in stock + variant filters", () => {
  it("parses instock and variant=axis:value, lower-cases, de-duplicates and drops junk", () => {
    const s = parseFilterState({ instock: "1", variant: ["Size:M", "size:m", "size:XL", "colour:Red", "nocolon", ":x", "Bad Axis:1", "size:"] });
    expect(s.inStock).toBe(true);
    expect(s.variants).toEqual({ colour: ["red"], size: ["m", "xl"] });
    expect(parseFilterState({ instock: "0" }).inStock).toBe(false);
  });
  it("caps axes and values", () => {
    const many = Array.from({ length: 9 }, (_, i) => `a${i}:x`);
    expect(Object.keys(parseFilterState({ variant: many }).variants)).toHaveLength(6);
    expect(parseFilterState({ variant: Array.from({ length: 30 }, (_, i) => `size:v${i}`) }).variants.size).toHaveLength(20);
  });
  it("maps to SearchFilters and counts as active filters", () => {
    const s = parseFilterState({ instock: "1", variant: "size:m" });
    expect(toSearchArgs(s).filters).toEqual({ inStockOnly: true, variantOptions: { size: ["m"] } });
    expect(hasFilters(s)).toBe(true);
    expect(activeCount(s)).toBe(2);
    expect(toSearchArgs(EMPTY_FILTERS).filters).toEqual({});
  });
  it("URL round-trips and every chip removes exactly its own constraint", () => {
    const s = parseFilterState({ instock: "1", variant: ["size:m", "size:l", "colour:red"] });
    expect(toSearchParams({}, s).toString()).toBe("instock=1&variant=colour%3Ared&variant=size%3Al&variant=size%3Am");
    const chips = chipSpecs(s);
    expect(chips.map((c) => c.kind + ":" + c.value)).toEqual(["instock:1", "variant:colour:red", "variant:size:l", "variant:size:m"]);
    expect(chips[1]!.without.variants).toEqual({ size: ["l", "m"] });
    expect(chips[2]!.without.variants).toEqual({ colour: ["red"], size: ["m"] });
  });
  it("a saved search keeps them (SearchFilters -> state -> URL)", async () => {
    const { filtersToState } = await import("@/features/retention/search-url");
    const st = filtersToState({ inStockOnly: true, variantOptions: { size: ["m"] } }, "relevance");
    expect(st.inStock).toBe(true);
    expect(st.variants).toEqual({ size: ["m"] });
  });
});
