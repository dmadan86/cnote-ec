// Invoice recipient snapshot. Billing reads businesses only through identity's public getter (ADR-006).
import { DomainError } from "@cnote/core";
import { getBusinessBillingProfile } from "@cnote/identity";

export interface PartyProfile {
  name: string;
  gstin: string | null;
  address: string;
  stateCode: string | null;
}

/** GSTIN positions 1-2 are the state code. */
export function stateFromGstin(gstin: string | null | undefined): string | null {
  return gstin && /^\d{2}[A-Z0-9]{13}$/i.test(gstin) ? gstin.slice(0, 2) : null;
}

export async function loadParty(businessId: string): Promise<PartyProfile> {
  const p = await getBusinessBillingProfile(businessId);
  if (!p) throw new DomainError("not_found", "Business not found");
  return p;
}
