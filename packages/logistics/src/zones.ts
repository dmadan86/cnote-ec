// PIN -> zone. State comes from the one India Post PIN table in @cnote/prices (ADR-022); zone rules are data-light and deterministic.
import { stateFromPincode } from "@cnote/prices";
import type { Zone } from "./types";

/** States/UTs priced as one "special" lane (hilly, remote or island: longer transit, higher surface rates). */
export const SPECIAL_STATES: ReadonlySet<string> = new Set([
  "assam", "arunachal-pradesh", "manipur", "meghalaya", "mizoram", "nagaland", "tripura", "sikkim",
  "jammu-and-kashmir", "ladakh", "andaman-and-nicobar-islands", "lakshadweep",
]);

/** 3-digit sorting districts of the big metro lanes: Delhi NCR, Mumbai, Bengaluru, Chennai, Kolkata, Hyderabad, Pune, Ahmedabad. */
export const METRO_PREFIXES: ReadonlySet<string> = new Set(["110", "121", "122", "201", "400", "401", "560", "600", "700", "500", "411", "380"]);

const validPin = (p: string | null | undefined): string | null => (p && /^[1-9]\d{5}$/.test(p.trim()) ? p.trim() : null);

export interface Lane {
  zone: Zone;
  originState: string | null;
  destinationState: string | null;
  originKnown: boolean;
  destinationKnown: boolean;
}

/** Classifies origin -> destination. Unknown origin degrades to `national` (the safe, higher lane) and is flagged. */
export function classifyLane(originPincode: string | null | undefined, destinationPincode: string | null | undefined): Lane {
  const o = validPin(originPincode);
  const d = validPin(destinationPincode);
  const os = o ? stateFromPincode(o) : null;
  const ds = d ? stateFromPincode(d) : null;
  const lane = { originState: os, destinationState: ds, originKnown: !!os, destinationKnown: !!ds };
  if (!o || !d || !os || !ds) return { ...lane, zone: "national" };
  if (o.slice(0, 3) === d.slice(0, 3)) return { ...lane, zone: "local" };
  if (os === ds) return { ...lane, zone: "intra_state" };
  if (SPECIAL_STATES.has(os) || SPECIAL_STATES.has(ds)) return { ...lane, zone: "special" };
  if (METRO_PREFIXES.has(o.slice(0, 3)) && METRO_PREFIXES.has(d.slice(0, 3))) return { ...lane, zone: "metro" };
  // same India Post postal zone (first digit) = neighbouring states
  if (o[0] === d[0]) return { ...lane, zone: "regional" };
  return { ...lane, zone: "national" };
}
