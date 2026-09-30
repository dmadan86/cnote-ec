// Delivery region (state, and pincode zone) from an Indian pincode (ADR-022). Longest-prefix lookup over the India Post
// PIN structure with border exceptions (regions-data.ts); see docs/design/prices.md.
import { PIN_MAX_PREFIX, PIN_MIN_PREFIX, PIN_PREFIX_STATE } from "./regions-data";

export const REGION_SLUGS: ReadonlySet<string> = new Set(Object.values(PIN_PREFIX_STATE));

/** Region key of a pincode zone (first three digits, the India Post sorting district): `pin-560`. */
export const ZONE_PREFIX = "pin-";
export const isZone = (region: string): boolean => /^pin-[1-8]\d{2}$/.test(region);

const validPin = (pincode: string | null | undefined): string | null => {
  const p = (pincode ?? "").trim();
  return /^[1-9]\d{5}$/.test(p) ? p : null;
};

/** State / union territory slug for a 6-digit PIN by longest matching India Post prefix; null when missing, malformed or Army Postal Service. */
export function stateFromPincode(pincode: string | null | undefined): string | null {
  const p = validPin(pincode);
  if (!p) return null;
  for (let n = PIN_MAX_PREFIX; n >= PIN_MIN_PREFIX; n--) {
    const s = PIN_PREFIX_STATE[p.slice(0, n)];
    if (s) return s;
  }
  return null;
}

/** Pincode zone key (`pin-560`) for a valid geographic PIN, or null (unmapped, Army Postal Service, or a border-exception PIN). */
export function zoneFromPincode(pincode: string | null | undefined): string | null {
  const p = validPin(pincode);
  const state = p ? stateFromPincode(p) : null;
  // a PIN that sits in a border exception (its state differs from its district's state) gets state cells only, so a zone never mixes states
  if (!p || !state || stateFromPincode(`${p.slice(0, 3)}000`) !== state) return null;
  return ZONE_PREFIX + p.slice(0, 3);
}

const ALIASES: Record<string, string> = { orissa: "odisha", pondicherry: "puducherry", uttaranchal: "uttarakhand", "nct-of-delhi": "delhi", "andaman-and-nicobar": "andaman-and-nicobar-islands", "dadra-and-nagar-haveli": "dadra-and-nagar-haveli-and-daman-and-diu", "daman-and-diu": "dadra-and-nagar-haveli-and-daman-and-diu" };

/** Slug for a free-text state name ("Tamil Nadu" -> "tamil-nadu"); null unless it is a known state. */
export function stateSlug(name: string | null | undefined): string | null {
  const s = (name ?? "").trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  const slug = ALIASES[s] ?? s;
  return REGION_SLUGS.has(slug) ? slug : null;
}

export function regionLabel(region: string): string {
  if (region === "national") return "India";
  if (isZone(region)) return `PIN ${region.slice(ZONE_PREFIX.length)}xxx`;
  return region.split("-").map((w) => (w === "and" ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}
