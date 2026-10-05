// Name / address match scoring against the business profile (pure, unit-tested). ADR-003 T1.
import { nameSimilarity } from "../gst/normalise";

export interface AddressParts {
  line?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

const STOP = new Set(["near", "opp", "opposite", "behind", "plot", "no", "number", "road", "rd", "street", "st", "floor", "flr", "the", "and", "of", "nagar", "colony", "area", "main", "po", "dist", "district", "tal", "taluka"]);
const tokens = (s: string | undefined): string[] =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

/**
 * Address similarity in [0,1]. Weighted: pincode 0.4 (exact), state 0.2, city 0.15, street-line token overlap 0.25
 * (Jaccard over the registered line plus city). Missing parts on either side are skipped and the rest re-weighted, so a
 * registry that only returns a free-text line still scores (the pincode is then pulled out of the text).
 */
export function addressSimilarity(declared: AddressParts, registry: AddressParts): number {
  const regPin = registry.pincode ?? /\b[1-9]\d{5}\b/.exec(registry.line ?? "")?.[0];
  let earned = 0, possible = 0;
  const add = (w: number, ok: number | null) => { if (ok === null) return; possible += w; earned += w * ok; };
  add(0.4, declared.pincode && regPin ? (declared.pincode === regPin ? 1 : 0) : null);
  add(0.2, declared.state && registry.state ? (nameSimilarity(declared.state, registry.state) >= 0.8 ? 1 : 0) : null);
  const regText = `${registry.line ?? ""} ${registry.city ?? ""}`;
  add(0.15, declared.city && regText.trim() ? (tokens(regText).some((t) => nameSimilarity(t, declared.city!) >= 0.8) || tokens(registry.city).includes(declared.city.toLowerCase()) ? 1 : 0) : null);
  const a = new Set(tokens(`${declared.line ?? ""} ${declared.city ?? ""}`)), b = new Set(tokens(regText));
  if (a.size && b.size) {
    const inter = [...a].filter((t) => b.has(t)).length;
    add(0.25, inter / (a.size + b.size - inter));
  }
  return possible === 0 ? 0 : Math.round((earned / possible) * 100) / 100;
}

export const ADDRESS_PASS = 0.7;
export const ADDRESS_REVIEW = 0.4;

export { nameSimilarity };
