// Unit normalisation (ADR-022): only convertible units are comparable. `factor` = canonical units per 1 raw unit.
// Prices convert as price/factor (per canonical unit); quantities as qty*factor. Unknown units are skipped.
export interface NormalUnit { unit: string; factor: number }

const T: Record<string, NormalUnit> = {};
const add = (canon: string, factor: number, ...names: string[]) => { for (const n of names) T[n] = { unit: canon, factor }; };
add("kg", 1, "kg", "kgs", "kilogram", "kilograms", "kilo");
add("kg", 0.001, "g", "gm", "gms", "gram", "grams");
add("kg", 100, "quintal", "quintals", "qtl");
add("kg", 1000, "tonne", "tonnes", "ton", "tons", "mt", "metric ton", "metric tonne");
add("pcs", 1, "pcs", "pc", "piece", "pieces", "nos", "no", "unit", "units", "each", "number");
add("pcs", 12, "dozen", "doz", "dz");
add("pcs", 144, "gross");
add("m", 1, "m", "mtr", "meter", "meters", "metre", "metres");
add("m", 0.01, "cm", "centimeter", "centimetre");
add("m", 0.3048, "ft", "foot", "feet");
add("l", 1, "l", "ltr", "litre", "litres", "liter", "liters");
add("l", 0.001, "ml", "millilitre", "milliliter");
add("l", 1000, "kl", "kilolitre", "kiloliter");
add("sqm", 1, "sqm", "sq m", "sq.m", "m2");
add("sqm", 0.092903, "sqft", "sq ft", "sq.ft", "ft2");
// Own-unit only: comparable within the same unit, never convertible.
for (const u of ["set", "pair", "box", "pack", "roll", "bag", "sheet", "carton", "bundle", "packet", "bottle"]) { T[u] = { unit: u, factor: 1 }; T[`${u}s`] = { unit: u, factor: 1 }; }

/** null when the unit is unknown / not convertible: the fact is skipped. */
export function normaliseUnit(raw: string | null | undefined): NormalUnit | null {
  if (!raw) return null;
  return T[raw.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/** Per-canonical-unit price (integer paise) and quantity for a raw price/quantity/unit; null if not comparable. */
export function normaliseFact(pricePaise: number, quantity: number, rawUnit: string | null | undefined): { unit: string; price: number; quantity: number; factor: number } | null {
  const n = normaliseUnit(rawUnit);
  if (!n || !(pricePaise > 0) || !(quantity > 0)) return null;
  const price = Math.round(pricePaise / n.factor);
  return price > 0 ? { unit: n.unit, price, quantity: quantity * n.factor, factor: n.factor } : null;
}

/** Quantity bands per canonical unit: [t1 < b1 <= t2 < b2 <= t3]. */
const BOUNDS: Record<string, [number, number]> = { kg: [100, 1000], pcs: [100, 1000], m: [100, 1000], l: [50, 500], sqm: [50, 500] };
const DEFAULT_BOUNDS: [number, number] = [10, 100];
export type Tier = "t1" | "t2" | "t3";
export const TIERS: readonly Tier[] = ["t1", "t2", "t3"];

export function tierOf(unit: string, qty: number): Tier {
  const [b1, b2] = BOUNDS[unit] ?? DEFAULT_BOUNDS;
  return qty < b1 ? "t1" : qty < b2 ? "t2" : "t3";
}
