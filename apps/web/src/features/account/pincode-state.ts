import { stateFromPincode, stateSlug } from "@cnote/prices";
import { STATE_TABLE } from "@/features/identity/states";

/**
 * Canonical state name (the GST/identity spelling, e.g. "Tamil Nadu") for a 6-digit pincode, derived from the
 * India Post PIN structure. Null for a malformed pincode, an Army Postal Service PIN or an unmapped prefix.
 */
export function stateNameFromPincode(pincode: string): string | null {
  const slug = stateFromPincode(pincode);
  if (!slug) return null;
  return STATE_TABLE.find((s) => stateSlug(s.name) === slug)?.name ?? null;
}
