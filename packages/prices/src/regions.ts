// Delivery region (state) from an Indian pincode (ADR-022). PIN prefixes map to postal circles, which follow state
// borders closely but not exactly; this is an approximation, documented in docs/design/prices.md.
const TWO: Record<string, string> = {};
const two = (state: string, ...prefixes: string[]) => { for (const p of prefixes) TWO[p] = state; };
two("delhi", "11"); two("haryana", "12", "13"); two("punjab", "14", "15", "16"); two("himachal-pradesh", "17");
two("jammu-and-kashmir", "18", "19"); two("uttar-pradesh", "20", "21", "22", "23", "24", "25", "26", "27", "28");
two("rajasthan", "30", "31", "32", "33", "34"); two("gujarat", "36", "37", "38", "39");
two("maharashtra", "40", "41", "42", "43", "44"); two("madhya-pradesh", "45", "46", "47", "48"); two("chhattisgarh", "49");
two("telangana", "50"); two("andhra-pradesh", "51", "52", "53"); two("karnataka", "56", "57", "58", "59");
two("tamil-nadu", "60", "61", "62", "63", "64"); two("kerala", "67", "68", "69"); two("west-bengal", "70", "71", "72", "73", "74");
two("odisha", "75", "76", "77"); two("assam", "78"); two("bihar", "80", "81", "82", "83", "84", "85");

const RANGES: [number, number, string][] = [
  [160, 160, "chandigarh"], [244, 249, "uttarakhand"], [262, 263, "uttarakhand"], [403, 403, "goa"], [605, 605, "puducherry"],
  [737, 737, "sikkim"], [790, 792, "arunachal-pradesh"], [793, 794, "meghalaya"], [795, 795, "manipur"], [796, 796, "mizoram"],
  [797, 798, "nagaland"], [799, 799, "tripura"], [813, 835, "jharkhand"],
];

export const REGION_SLUGS: ReadonlySet<string> = new Set([...Object.values(TWO), ...RANGES.map((r) => r[2])]);

/** State slug for a 6-digit PIN, or null when missing / malformed / unmapped. */
export function stateFromPincode(pincode: string | null | undefined): string | null {
  const p = (pincode ?? "").trim();
  if (!/^[1-9]\d{5}$/.test(p)) return null;
  const three = Number(p.slice(0, 3));
  for (const [lo, hi, s] of RANGES) if (three >= lo && three <= hi) return s;
  return TWO[p.slice(0, 2)] ?? null;
}

/** Slug for a free-text state name ("Tamil Nadu" -> "tamil-nadu"); null unless it is a known state. */
export function stateSlug(name: string | null | undefined): string | null {
  const s = (name ?? "").trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  return REGION_SLUGS.has(s) ? s : null;
}

export function regionLabel(region: string): string {
  if (region === "national") return "India";
  return region.split("-").map((w) => (w === "and" ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}
