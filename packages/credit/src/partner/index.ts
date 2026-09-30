// Partner factory: CREDIT_PARTNER=mock|nbfc_partner (default mock).
import { DomainError } from "@cnote/core";
import { MockPartner } from "./mock";
import { NbfcPartnerStub } from "./stub";
import { isPartnerName, type CreditPartner, type PartnerName } from "./types";

export * from "./types";
export { MockPartner, MOCK_LENDER, mockPricing, mockSecret, assertMockAllowed } from "./mock";
export { NbfcPartnerStub } from "./stub";
export { SIGNATURE_HEADER, parsePartnerEvent, verifySigned, hmacHex } from "./events";

const instances = new Map<PartnerName, CreditPartner>();
let override: CreditPartner | null = null;

/** Tests / composition root: replace the partner (null restores the env-selected one). */
export function setCreditPartner(p: CreditPartner | null): void { override = p; }

export function configuredPartnerName(env: NodeJS.ProcessEnv = process.env): PartnerName {
  const v = env.CREDIT_PARTNER ?? "mock";
  if (!isPartnerName(v)) throw new DomainError("validation", `Unknown CREDIT_PARTNER "${v}".`);
  return v;
}

export function getCreditPartner(name: string = override?.name ?? configuredPartnerName()): CreditPartner {
  if (!isPartnerName(name)) throw new DomainError("not_found", "Unknown credit partner.");
  if (override && override.name === name) return override;
  let p = instances.get(name);
  if (!p) {
    p = name === "mock" ? new MockPartner() : new NbfcPartnerStub();
    instances.set(name, p);
  }
  return p;
}
