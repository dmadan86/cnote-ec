import { cachedTagged, cacheTags } from "@cnote/core";
import { listCategories, suggestListingTitles } from "@cnote/catalogue";

/** Matches the "Try asking" chips on the home page. */
export const EXAMPLE_QUERIES = [
  "Packaging boxes for cosmetics",
  "T-shirts manufacturers in India",
  "Custom Diwali gift items",
  "Office furniture suppliers",
];

const matches = (s: string, p: string) => {
  const l = s.toLowerCase();
  return l.startsWith(p) || l.split(/\s+/).some((w) => w.startsWith(p));
};

export async function suggest(prefix: string, limit = 8): Promise<string[]> {
  const p = prefix.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 50);
  const n = Math.max(1, Math.min(20, Math.trunc(limit)));
  if (!p) return EXAMPLE_QUERIES.slice(0, n);
  return cachedTagged(`search:suggest:v2:${n}:${p}`, [cacheTags.search, cacheTags.categories], 300, async () => {
    const [cats, titles] = await Promise.all([listCategories(), suggestListingTitles(p, n)]);
    const all = [
      ...EXAMPLE_QUERIES.filter((q) => matches(q, p)),
      ...cats.filter((c) => !c.prohibited && matches(c.name, p)).map((c) => c.name),
      ...titles,
    ];
    const seen = new Set<string>();
    return all.filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true))).slice(0, n);
  }, { staleSeconds: 1800 });
}
