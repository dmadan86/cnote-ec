import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import bn from "../messages/bn.prices.json";
import en from "../messages/en.prices.json";
import gu from "../messages/gu.prices.json";
import hi from "../messages/hi.prices.json";
import kn from "../messages/kn.prices.json";
import mr from "../messages/mr.prices.json";
import ta from "../messages/ta.prices.json";
import te from "../messages/te.prices.json";

vi.mock("@/features/prices/actions", () => ({ lookupBenchmarkAction: async () => null }));
const { BenchmarkHint } = await import("@/features/prices/benchmark-hint");

type Json = { [k: string]: Json | string };
const flat = (o: Json, p = ""): Record<string, string> => Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (k.startsWith("_") ? a : typeof v === "string" ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Json);
const ph = (m: string) => [...m.matchAll(/\{(\w+)/g)].map((x) => x[1]!).sort().join();

describe("prices catalogue", () => {
  for (const [loc, cat] of Object.entries({ hi, kn, ta, te, mr, gu, bn })) {
    it(`${loc} has exactly the keys and placeholders of en, is translated and flagged for review`, () => {
      const L = flat(cat as Json);
      expect(Object.keys(L).sort()).toEqual(Object.keys(E).sort());
      for (const k of Object.keys(E)) { expect(ph(L[k]!), k).toBe(ph(E[k]!)); expect(L[k], k).not.toBe(E[k]); }
      expect((cat as Json)._meta).toEqual({ review: "machine-drafted; needs native review" });
    });
  }
  it("English says the range is indicative and anonymised", () => {
    expect(E["prices.basis"]).toMatch(/Indicative only/);
    expect(E["prices.basis"]).toMatch(/anonymised/);
  });
});

describe("BenchmarkHint accessibility contract", () => {
  const labels = { title: "Typical price range", sectionLabel: "x", widerArea: "w", checking: "c", range: "r", basis: "b", trendUp: "u", trendDown: "d", trendFlat: "f" };
  const html = renderToStaticMarkup(<BenchmarkHint labels={labels} />);
  it("is a labelled section with a polite live region and stays hidden until there is a category", () => {
    expect(html).toContain('aria-labelledby="price-hint-heading"');
    expect(html).toContain('id="price-hint-heading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<section[^>]*hidden/);
    expect(html).toMatch(/<h2/);
  });
  it("has no interactive controls or colour-only cues to trap focus", () => {
    expect(html).not.toMatch(/<(button|input|a|select)\b/);
  });
});
